use std::process::Command;
#[cfg(any(unix, test))]
use std::{env, ffi::OsStr, ffi::OsString, path::Path};
#[cfg(unix)]
use std::thread;
#[cfg(all(unix, not(test)))]
use std::{os::unix::ffi::OsStringExt, process::Stdio, time::Duration, time::Instant};
#[cfg(any(unix, test))]
use std::{io::ErrorKind, io::Read};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(unix)]
use std::{collections::HashSet, path::PathBuf, sync::OnceLock};

#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(any(target_os = "linux", test))]
const APPIMAGE_PATH_ENVIRONMENT: [&str; 6] = [
    "LD_LIBRARY_PATH",
    "PATH",
    "XDG_DATA_DIRS",
    "GSETTINGS_SCHEMA_DIR",
    "GIO_MODULE_DIR",
    "GIO_EXTRA_MODULES",
];

#[cfg(all(unix, not(test)))]
const SHELL_PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(all(unix, not(test)))]
const SHELL_PATH_PROBE_OUTPUT_LIMIT: u64 = 64 * 1024;
#[cfg(any(unix, test))]
const SHELL_PATH_PROBE_MARKER: &str = "GITNAV_LOGIN_ENVIRONMENT";

#[cfg(unix)]
static EFFECTIVE_PATH: OnceLock<OsString> = OnceLock::new();

#[cfg(unix)]
fn fallback_path_prefixes(home: Option<&Path>) -> Vec<PathBuf> {
    let mut prefixes = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = home {
        prefixes.push(home.join(".local/bin"));
    }
    prefixes.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
    prefixes.push(PathBuf::from("/usr/bin"));
    prefixes.push(PathBuf::from("/bin"));
    prefixes
}

#[cfg(unix)]
fn merged_path_list(
    discovered: impl IntoIterator<Item = PathBuf>,
    fallbacks: impl IntoIterator<Item = PathBuf>,
    inherited: &OsStr,
) -> OsString {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    // The inherited PATH is the process's actual environment (a terminal or direnv launch already
    // enriched it), the login-shell answer only fills in what a Dock launch lacks, and the
    // fallbacks are a guess, so the guess goes last.
    for path in env::split_paths(inherited)
        .chain(discovered)
        .chain(fallbacks)
    {
        if !path.as_os_str().is_empty()
            && env::join_paths([&path]).is_ok()
            && seen.insert(path.clone())
        {
            paths.push(path);
        }
    }
    env::join_paths(paths).expect("individually joinable paths must join together")
}

#[cfg(any(unix, test))]
fn shell_path_from_environment(output: &[u8]) -> Option<&[u8]> {
    let mut lines = output.split_inclusive(|byte| *byte == b'\n');
    lines.find(|line| line.strip_suffix(b"\n") == Some(SHELL_PATH_PROBE_MARKER.as_bytes()))?;
    lines.next()?.strip_suffix(b"\n")
}

#[cfg(any(unix, test))]
fn read_shell_path_probe_output(reader: &mut impl Read) -> Vec<u8> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 1024];
    while shell_path_from_environment(&output).is_none() {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => output.extend_from_slice(&chunk[..count]),
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    output
}

#[cfg(target_os = "linux")]
fn inherited_command_path() -> OsString {
    let path = env::var_os("PATH").unwrap_or_default();
    let (Some(app_dir), Some(_)) = (env::var_os("APPDIR"), env::var_os("APPIMAGE")) else {
        return path;
    };
    sanitized_appimage_path_list(&path, Path::new(&app_dir)).unwrap_or_default()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn inherited_command_path() -> OsString {
    env::var_os("PATH").unwrap_or_default()
}

#[cfg(all(unix, not(test)))]
fn shell_path_from_login_shell(inherited: &OsStr) -> Option<OsString> {
    let shell = env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/sh"));
    let mut command = Command::new(shell);
    #[cfg(target_os = "linux")]
    sanitize_appimage_environment(&mut command);
    command
        .args(["-l", "-i", "-c"])
        .arg(format!(
            "printf '\\n{}\\n'; exec /usr/bin/printenv PATH",
            SHELL_PATH_PROBE_MARKER
        ))
        .env("PATH", inherited)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        // Stop at the completed PATH line: rc files can leave background children holding the
        // pipe open, so waiting for EOF would outlive the shell and hit the probe deadline.
        let mut reader = stdout.take(SHELL_PATH_PROBE_OUTPUT_LIMIT);
        let _ = sender.send(read_shell_path_probe_output(&mut reader));
    });

    let deadline = Instant::now() + SHELL_PATH_PROBE_TIMEOUT;
    loop {
        let status = match child.try_wait() {
            Ok(status) => status,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        };
        match status {
            Some(status) if status.success() => break,
            Some(_) => return None,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            None => thread::sleep(Duration::from_millis(10)),
        }
    }

    receiver
        .try_recv()
        .ok()
        .or_else(|| {
            receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .ok()
        })
        .and_then(|output| {
            shell_path_from_environment(&output).map(|path| OsString::from_vec(path.to_vec()))
        })
}

#[cfg(unix)]
fn effective_path() -> OsString {
    EFFECTIVE_PATH
        .get_or_init(|| {
            let inherited = inherited_command_path();
            #[cfg(not(test))]
            let discovered: Option<OsString> = shell_path_from_login_shell(&inherited);
            #[cfg(test)]
            let discovered: Option<OsString> = None;
            let fallbacks = fallback_path_prefixes(env::var_os("HOME").as_deref().map(Path::new));
            merged_path_list(
                discovered.as_deref().map(env::split_paths).into_iter().flatten(),
                fallbacks,
                &inherited,
            )
        })
        .clone()
}

#[cfg(unix)]
fn apply_effective_path(command: &mut Command) {
    command.env("PATH", effective_path());
}

#[cfg(unix)]
pub(crate) fn warm_effective_path() {
    // A slow shell rc holds the probe for up to its deadline, so start resolving off the main
    // thread before the first window's git commands need the PATH.
    thread::spawn(|| {
        effective_path();
    });
}

pub(crate) fn external_command(program: &str) -> Command {
    let command = Command::new(program);
    #[cfg(any(unix, target_os = "windows"))]
    let mut command = command;
    #[cfg(target_os = "linux")]
    sanitize_appimage_environment(&mut command);
    #[cfg(unix)]
    apply_effective_path(&mut command);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn desktop_process(program: &str) -> Command {
    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new(program);
        sanitize_appimage_environment(&mut command);
        apply_effective_path(&mut command);
        command
    }
    #[cfg(target_os = "windows")]
    {
        Command::new(program)
    }
}

#[cfg(any(target_os = "linux", test))]
fn sanitized_appimage_path_list(value: &OsStr, app_dir: &Path) -> Option<OsString> {
    // AppRun appends the original values after its bundled prefixes, so retain every non-bundled entry.
    let paths: Vec<_> = env::split_paths(value).filter(|path| !path.starts_with(app_dir)).collect();
    (!paths.is_empty()).then(|| env::join_paths(paths).expect("split environment paths must rejoin"))
}

#[cfg(target_os = "linux")]
fn sanitize_appimage_environment(command: &mut Command) {
    let (Some(app_dir), Some(_)) = (env::var_os("APPDIR"), env::var_os("APPIMAGE")) else {
        return;
    };
    apply_appimage_environment(command, Path::new(&app_dir), |name| env::var_os(name));
}

#[cfg(any(target_os = "linux", test))]
fn apply_appimage_environment(
    command: &mut Command,
    app_dir: &Path,
    value: impl Fn(&str) -> Option<OsString>,
) {
    for name in APPIMAGE_PATH_ENVIRONMENT {
        let Some(value) = value(name) else {
            continue;
        };
        match sanitized_appimage_path_list(&value, app_dir) {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn joined_paths<const N: usize>(paths: [&str; N]) -> OsString {
        env::join_paths(paths).unwrap()
    }

    #[test]
    #[cfg(unix)]
    fn merges_inherited_discovered_and_fallback_paths_without_duplicates() {
        let inherited = joined_paths(["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
        let merged = merged_path_list(
            [
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/home/user/.local/bin"),
                PathBuf::from("/usr/bin"),
            ],
            [
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/opt/homebrew/sbin"),
                PathBuf::from("/usr/local/bin"),
                PathBuf::from("/home/user/.local/bin"),
            ],
            &inherited,
        );

        assert_eq!(
            merged,
            joined_paths([
                "/usr/bin",
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/home/user/.local/bin",
                "/opt/homebrew/sbin",
            ])
        );
    }

    #[test]
    #[cfg(unix)]
    fn keeps_inherited_entries_ahead_of_fallback_prefixes_when_the_probe_fails() {
        let inherited = joined_paths(["/home/user/.asdf/shims", "/usr/bin", "/bin"]);
        let merged = merged_path_list(
            [],
            fallback_path_prefixes(Some(Path::new("/home/user"))),
            &inherited,
        );

        assert_eq!(
            merged,
            joined_paths([
                "/home/user/.asdf/shims",
                "/usr/bin",
                "/bin",
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/home/user/.local/bin",
                "/home/linuxbrew/.linuxbrew/bin",
            ])
        );
    }

    #[test]
    #[cfg(unix)]
    fn keeps_an_inherited_version_manager_shim_ahead_of_its_discovered_duplicate() {
        let inherited = joined_paths(["/home/user/.local/share/mise/shims", "/usr/bin"]);
        let merged = merged_path_list(
            [
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/home/user/.local/share/mise/shims"),
                PathBuf::from("/usr/bin"),
            ],
            [],
            &inherited,
        );

        assert_eq!(
            merged,
            joined_paths([
                "/home/user/.local/share/mise/shims",
                "/usr/bin",
                "/opt/homebrew/bin",
            ])
        );
    }

    #[test]
    #[cfg(unix)]
    fn drops_empty_path_components() {
        let inherited = env::join_paths([PathBuf::new(), PathBuf::from("/usr/bin"), PathBuf::new()])
            .unwrap();
        let merged = merged_path_list(
            [PathBuf::new(), PathBuf::from("/shell/bin")],
            [PathBuf::new(), PathBuf::from("/fallback/bin")],
            &inherited,
        );

        assert_eq!(
            merged,
            joined_paths(["/usr/bin", "/shell/bin", "/fallback/bin"])
        );
    }

    #[cfg(unix)]
    #[test]
    #[cfg(unix)]
    fn drops_only_the_home_fallback_that_cannot_be_joined() {
        let inherited = joined_paths(["/usr/bin", "/bin"]);
        let merged = merged_path_list(
            [],
            fallback_path_prefixes(Some(Path::new("/tmp/dev:profile"))),
            &inherited,
        );

        assert_eq!(
            merged,
            joined_paths([
                "/usr/bin",
                "/bin",
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/home/linuxbrew/.linuxbrew/bin",
            ])
        );
    }

    #[test]
    #[cfg(unix)]
    fn uses_well_known_fallback_path_prefixes() {
        assert_eq!(
            fallback_path_prefixes(Some(Path::new("/home/user"))),
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/opt/homebrew/sbin"),
                PathBuf::from("/usr/local/bin"),
                PathBuf::from("/home/user/.local/bin"),
                PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
            ]
        );
    }

    #[test]
    #[cfg(unix)]
    fn adds_fallback_paths_after_a_successful_shell_probe() {
        let inherited = joined_paths(["/usr/bin"]);
        let merged = merged_path_list(
            [PathBuf::from("/usr/bin")],
            fallback_path_prefixes(Some(Path::new("/home/user"))),
            &inherited,
        );

        assert_eq!(
            merged,
            joined_paths([
                "/usr/bin",
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/home/user/.local/bin",
                "/home/linuxbrew/.linuxbrew/bin",
                "/bin",
            ])
        );
    }

    #[test]
    fn reads_path_from_the_marked_environment() {
        assert_eq!(
            shell_path_from_environment(
                b"shell banner\nGITNAV_LOGIN_ENVIRONMENT\n/opt/homebrew/bin:/usr/bin\n"
            ),
            Some(&b"/opt/homebrew/bin:/usr/bin"[..])
        );
    }

    #[test]
    fn reads_path_when_a_partial_line_precedes_the_marker() {
        assert_eq!(
            shell_path_from_environment(
                b"shell title\nGITNAV_LOGIN_ENVIRONMENT\n/opt/homebrew/bin:/usr/bin\n"
            ),
            Some(&b"/opt/homebrew/bin:/usr/bin"[..])
        );
    }

    #[test]
    fn requires_a_terminated_path_line() {
        assert_eq!(
            shell_path_from_environment(
                b"GITNAV_LOGIN_ENVIRONMENT\n/opt/homebrew/bin:/usr"
            ),
            None
        );
    }

    #[test]
    fn reads_a_path_line_split_across_chunks() {
        let path = format!("/opt/{}", "x".repeat(1024));
        let mut output = format!("{SHELL_PATH_PROBE_MARKER}\n").into_bytes();
        output.extend_from_slice(path.as_bytes());
        output.push(b'\n');

        let mut reader = std::io::Cursor::new(output.clone());
        let read = read_shell_path_probe_output(&mut reader);

        assert_eq!(read, output);
        assert_eq!(shell_path_from_environment(&read), Some(path.as_bytes()));
    }

    #[test]
    fn stops_reading_when_the_probe_output_limit_is_reached_without_a_marker() {
        let mut reader = std::io::Cursor::new(b"output without a marker").take(6);

        assert_eq!(read_shell_path_probe_output(&mut reader), b"output");
    }

    #[test]
    fn reads_path_before_continuing_output() {
        assert_eq!(
            shell_path_from_environment(
                b"GITNAV_LOGIN_ENVIRONMENT\n/opt/homebrew/bin:/usr/bin\nSHELL=/bin/zsh\n"
            ),
            Some(&b"/opt/homebrew/bin:/usr/bin"[..])
        );
    }

    #[test]
    fn ignores_path_output_before_the_marker() {
        assert_eq!(
            shell_path_from_environment(
                b"/usr/bin\nGITNAV_LOGIN_ENVIRONMENT\n/opt/homebrew/bin:/usr/bin\n"
            ),
            Some(&b"/opt/homebrew/bin:/usr/bin"[..])
        );
    }

    #[test]
    fn requires_path_in_the_marked_environment() {
        assert_eq!(
            shell_path_from_environment(b"GITNAV_LOGIN_ENVIRONMENT\n"),
            None
        );
    }

    #[test]
    fn removes_mounted_appimage_paths_and_preserves_original_values() {
        let app_dir = Path::new("/tmp/.mount_gitnav");
        let value = joined_paths([
            "/tmp/.mount_gitnav/usr/bin",
            "/tmp/.mount_gitnav/usr/lib",
            "/home/user/bin",
            "/usr/local/bin",
            "/usr/bin",
        ]);

        assert_eq!(
            sanitized_appimage_path_list(&value, app_dir),
            Some(joined_paths(["/home/user/bin", "/usr/local/bin", "/usr/bin"]))
        );
    }

    #[test]
    #[cfg(unix)]
    fn merges_fallback_paths_after_sanitizing_an_appimage_path() {
        let app_dir = Path::new("/tmp/.mount_gitnav");
        let inherited = joined_paths([
            "/tmp/.mount_gitnav/usr/bin",
            "/usr/bin",
            "/opt/homebrew/bin",
        ]);
        let sanitized = sanitized_appimage_path_list(&inherited, app_dir).unwrap();
        let merged = merged_path_list(
            [],
            fallback_path_prefixes(Some(Path::new("/home/user"))),
            &sanitized,
        );

        assert_eq!(
            merged,
            joined_paths([
                "/usr/bin",
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/home/user/.local/bin",
                "/home/linuxbrew/.linuxbrew/bin",
                "/bin",
            ])
        );
    }

    #[test]
    fn removes_extracted_appimage_paths_wherever_apprun_inserted_them() {
        let app_dir = Path::new("/tmp/appimage_extracted_1234");
        let value = joined_paths([
            "/tmp/appimage_extracted_1234/usr/share",
            "/usr/share",
            "/tmp/appimage_extracted_1234/usr/share/",
            "/custom/share",
        ]);

        assert_eq!(
            sanitized_appimage_path_list(&value, app_dir),
            Some(joined_paths(["/usr/share", "/custom/share"]))
        );
    }

    #[test]
    fn removes_an_appimage_only_environment_value() {
        assert_eq!(
            sanitized_appimage_path_list(
                OsStr::new("/tmp/.mount_gitnav/usr/share/glib-2.0/schemas"),
                Path::new("/tmp/.mount_gitnav"),
            ),
            None
        );
    }

    #[test]
    fn preserves_paths_outside_the_exact_appimage_root() {
        let value = joined_paths(["/tmp/.mount_gitnav-tools/bin", "/tmp/.mount_gitnav/usr/bin"]);

        assert_eq!(
            sanitized_appimage_path_list(&value, Path::new("/tmp/.mount_gitnav")),
            Some(OsString::from("/tmp/.mount_gitnav-tools/bin"))
        );
    }

    #[test]
    fn applies_sanitization_to_every_external_command_environment_variable() {
        let app_dir = Path::new("/tmp/.mount_gitnav");
        let mut command = Command::new("git");
        apply_appimage_environment(&mut command, app_dir, |_| {
            Some(joined_paths(["/tmp/.mount_gitnav/usr/lib", "/original/value"]))
        });
        let changes: HashMap<_, _> = command
            .get_envs()
            .map(|(name, value)| (name.to_string_lossy().into_owned(), value.map(OsStr::to_os_string)))
            .collect();

        for name in APPIMAGE_PATH_ENVIRONMENT {
            assert_eq!(changes.get(name), Some(&Some(OsString::from("/original/value"))));
        }
    }
}
