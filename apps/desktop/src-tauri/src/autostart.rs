use std::env;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::path::PathBuf;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::fs;
#[cfg(any(target_os = "macos", target_os = "linux", test))]
use crate::storage::APPLICATION_IDENTIFIER;

#[cfg(any(target_os = "macos", test))]
fn xml_escaped(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// ProgramArguments entries are not shell-parsed, so a path with spaces needs no quoting.
#[cfg(any(target_os = "macos", test))]
fn macos_autostart_plist(executable: &str) -> String {
    let executable = xml_escaped(executable);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{APPLICATION_IDENTIFIER}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{executable}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>
"#
    )
}

/// Quotes an Exec argument per the Desktop Entry Specification: reserved characters are escaped
/// once for the quoted argument and once more for the string value, and % is doubled so it cannot
/// start a field code.
#[cfg(any(target_os = "linux", test))]
fn desktop_entry_exec_argument(path: &str) -> String {
    let mut argument = String::from("\"");
    for character in path.chars() {
        match character {
            '\\' => argument.push_str(r"\\\\"),
            '"' => argument.push_str(r#"\\""#),
            '`' => argument.push_str(r"\\`"),
            '$' => argument.push_str(r"\\$"),
            '%' => argument.push_str("%%"),
            _ => argument.push(character),
        }
    }
    argument.push('"');
    argument
}

/// An AppImage is started through its bundle path, since the mount current_exe points into
/// unwinds with this process, and with APPIMAGE_EXTRACT_AND_RUN=1 so it also starts where FUSE is
/// unavailable, the same way the CLI launcher starts it.
#[cfg(any(target_os = "linux", test))]
fn linux_autostart_entry(appimage: Option<&str>, executable: &str) -> String {
    let exec = match appimage {
        Some(bundle) => format!(
            "env APPIMAGE_EXTRACT_AND_RUN=1 {}",
            desktop_entry_exec_argument(bundle)
        ),
        None => desktop_entry_exec_argument(executable),
    };
    format!("[Desktop Entry]\nType=Application\nName=Git Nav\nExec={exec}\nTerminal=false\n")
}

#[cfg(target_os = "macos")]
fn autostart_entry_path() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "Could not find the home directory.".to_string())?
        .join("Library/LaunchAgents")
        .join(format!("{APPLICATION_IDENTIFIER}.plist")))
}

#[cfg(target_os = "linux")]
fn autostart_entry_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or_else(|| "Could not find the configuration directory.".to_string())?
        .join("autostart")
        .join(format!("{APPLICATION_IDENTIFIER}.desktop")))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn autostart_entry_contents() -> Result<String, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        Ok(macos_autostart_plist(&executable.to_string_lossy()))
    }
    #[cfg(target_os = "linux")]
    {
        let appimage = env::var_os("APPIMAGE");
        let appimage = appimage.as_ref().map(|bundle| bundle.to_string_lossy());
        Ok(linux_autostart_entry(
            appimage.as_deref(),
            &executable.to_string_lossy(),
        ))
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn enable_autostart_entry() -> Result<(), String> {
    let path = autostart_entry_path()?;
    let directory = path
        .parent()
        .ok_or_else(|| "Could not find the autostart directory.".to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    fs::write(&path, autostart_entry_contents()?).map_err(|error| error.to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn disable_autostart_entry() -> Result<(), String> {
    match fs::remove_file(autostart_entry_path()?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn autostart_entry_enabled() -> Result<bool, String> {
    Ok(autostart_entry_path()?.exists())
}

/// Quotes keep a path with spaces from being read as a program plus arguments.
#[cfg(any(target_os = "windows", test))]
fn windows_autostart_command(executable: &str) -> String {
    format!("\"{executable}\"")
}

#[cfg(target_os = "windows")]
const AUTOSTART_RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const AUTOSTART_RUN_VALUE: &str = "Git Nav";

#[cfg(target_os = "windows")]
fn enable_autostart_entry() -> Result<(), String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    windows_registry::CURRENT_USER
        .create(AUTOSTART_RUN_KEY)
        .and_then(|key| {
            key.set_string(
                AUTOSTART_RUN_VALUE,
                windows_autostart_command(&executable.to_string_lossy()),
            )
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn disable_autostart_entry() -> Result<(), String> {
    let key = windows_registry::CURRENT_USER
        .create(AUTOSTART_RUN_KEY)
        .map_err(|error| error.to_string())?;
    if key.get_string(AUTOSTART_RUN_VALUE).is_err() {
        return Ok(());
    }
    key.remove_value(AUTOSTART_RUN_VALUE)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn autostart_entry_enabled() -> Result<bool, String> {
    Ok(windows_registry::CURRENT_USER
        .open(AUTOSTART_RUN_KEY)
        .and_then(|key| key.get_string(AUTOSTART_RUN_VALUE))
        .is_ok())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
const AUTOSTART_UNSUPPORTED: &str =
    "Starting at login is currently supported on macOS, Linux, and Windows only.";

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn enable_autostart_entry() -> Result<(), String> {
    Err(AUTOSTART_UNSUPPORTED.to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn disable_autostart_entry() -> Result<(), String> {
    Err(AUTOSTART_UNSUPPORTED.to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn autostart_entry_enabled() -> Result<bool, String> {
    Err(AUTOSTART_UNSUPPORTED.to_string())
}

#[tauri::command]
pub(crate) fn set_autostart(enabled: bool) -> Result<(), String> {
    if enabled {
        enable_autostart_entry()
    } else {
        disable_autostart_entry()
    }
}

#[tauri::command]
pub(crate) fn autostart_enabled() -> Result<bool, String> {
    autostart_entry_enabled()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_desktop_entry_exec_arguments() {
        assert_eq!(
            desktop_entry_exec_argument("/home/user/Git Nav/git-nav"),
            r#""/home/user/Git Nav/git-nav""#
        );
        assert_eq!(
            desktop_entry_exec_argument(r#"/tmp/a"b`c$d\e%f"#),
            r#""/tmp/a\\"b\\`c\\$d\\\\e%%f""#
        );
    }

    #[test]
    fn linux_autostart_runs_an_appimage_the_way_the_cli_launcher_does() {
        let entry = linux_autostart_entry(Some("/opt/my apps/git-nav.AppImage"), "/proc/self/exe");

        assert!(entry.contains(
            "Exec=env APPIMAGE_EXTRACT_AND_RUN=1 \"/opt/my apps/git-nav.AppImage\"\n"
        ));
    }

    #[test]
    fn linux_autostart_runs_the_executable_when_there_is_no_appimage() {
        let entry = linux_autostart_entry(None, "/usr/local/bin/git-nav");

        assert!(entry.contains("Exec=\"/usr/local/bin/git-nav\"\n"));
    }

    #[test]
    fn windows_autostart_quotes_the_executable() {
        assert_eq!(
            windows_autostart_command(r"C:\Program Files\Git Nav\git-nav.exe"),
            r#""C:\Program Files\Git Nav\git-nav.exe""#
        );
    }

    #[test]
    fn macos_autostart_escapes_the_executable_for_the_plist() {
        let plist = macos_autostart_plist("/Applications/Git <&> Nav.app/Contents/MacOS/git-nav");

        assert!(plist.contains(
            "<string>/Applications/Git &lt;&amp;&gt; Nav.app/Contents/MacOS/git-nav</string>"
        ));
    }
}
