use serde::Serialize;
use std::env;
#[cfg(any(target_os = "macos", all(unix, test)))]
use std::{fs, path::Path};
use tauri::AppHandle;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use crate::window::open_repository_window;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use crate::process::desktop_process;
#[cfg(target_os = "windows")]
use crate::process::CREATE_NO_WINDOW;
#[cfg(target_os = "macos")]
use crate::process::external_command;

#[tauri::command]
pub(crate) fn update_command() -> Option<String> {
    env::var("GIT_NAV_UPDATE_COMMAND").ok()
}

/// Where `git nav` has to be for a shell to find it: first on the default macOS path, and owned by
/// root, so linking it asks for an administrator once.
#[cfg(target_os = "macos")]
const COMMAND_LINE_LINK: &str = "/usr/local/bin/git-nav";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandLineLink {
    path: Option<String>,
    state: &'static str,
}

#[cfg(not(target_os = "macos"))]
fn read_command_line_link() -> CommandLineLink {
    // Every other installer puts the executable on the path itself.
    CommandLineLink { path: None, state: "unsupported" }
}

/// A link that points anywhere but here is reported as its own state, because an app that moved
/// leaves one behind and the menu has to offer to write it again rather than call it installed.
#[cfg(any(target_os = "macos", all(unix, test)))]
fn command_line_link_at(link: &Path, executable: &Path) -> CommandLineLink {
    let found = CommandLineLink { path: Some(link.to_string_lossy().into_owned()), state: "missing" };
    match fs::read_link(link) {
        Ok(target) if target == executable => CommandLineLink { state: "installed", ..found },
        Ok(_) => CommandLineLink { state: "elsewhere", ..found },
        Err(_) if link.exists() => CommandLineLink { state: "elsewhere", ..found },
        Err(_) => found,
    }
}

#[cfg(target_os = "macos")]
fn read_command_line_link() -> CommandLineLink {
    let Ok(executable) = env::current_exe() else {
        return CommandLineLink {
            path: Some(COMMAND_LINE_LINK.to_string()),
            state: "missing",
        };
    };
    command_line_link_at(Path::new(COMMAND_LINE_LINK), &executable)
}

#[tauri::command]
pub(crate) fn command_line_link() -> CommandLineLink {
    read_command_line_link()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command(async)]
pub(crate) fn install_command_line_link() -> Result<CommandLineLink, String> {
    Err("Git Nav is already on the path on this platform.".to_string())
}

/// Links without asking first, because a path a user can write needs no administrator, and only
/// falls back to the prompt when the link is refused.
#[cfg(target_os = "macos")]
#[tauri::command(async)]
pub(crate) fn install_command_line_link() -> Result<CommandLineLink, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    // The path reaches a shell through osascript, where a quote of its own would end the argument.
    if executable.to_string_lossy().contains('\'') {
        return Err("Move Git Nav somewhere without a quote in its path.".to_string());
    }

    let _ = fs::remove_file(COMMAND_LINE_LINK);
    match std::os::unix::fs::symlink(&executable, COMMAND_LINE_LINK) {
        Ok(()) => return Ok(read_command_line_link()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {}
        Err(error) => return Err(error.to_string()),
    }

    let script = format!(
        "do shell script \"mkdir -p /usr/local/bin && ln -sf '{}' '{}'\" with administrator privileges",
        executable.display(),
        COMMAND_LINE_LINK,
    );
    let output = external_command("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(if message.contains("User canceled") {
            "Installing the command line tool needs an administrator.".to_string()
        } else {
            message.trim().to_string()
        });
    }

    Ok(read_command_line_link())
}

#[derive(Debug, PartialEq)]
pub(crate) struct DesktopCommand {
    program: &'static str,
    arguments: Vec<String>,
    current_dir: Option<String>,
    hide_console: bool,
}

impl DesktopCommand {
    fn new(program: &'static str, arguments: Vec<String>) -> Self {
        Self { program, arguments, current_dir: None, hide_console: false }
    }

    #[cfg(any(target_os = "linux", target_os = "windows", test))]
    fn in_directory(program: &'static str, path: &str) -> Self {
        Self { program, arguments: Vec::new(), current_dir: Some(path.to_string()), hide_console: false }
    }

    #[cfg(any(target_os = "windows", test))]
    fn hidden(program: &'static str, arguments: Vec<String>) -> Self {
        Self { program, arguments, current_dir: None, hide_console: true }
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_worktree_command(path: &str, target: &str) -> Result<DesktopCommand, String> {
    let arguments = match target {
        "vscode" => vec!["-a".to_string(), "Visual Studio Code".to_string(), path.to_string()],
        "terminal" => vec!["-a".to_string(), "Terminal".to_string(), path.to_string()],
        "finder" => vec![path.to_string()],
        _ => return Err("Unknown worktree target.".to_string()),
    };
    Ok(DesktopCommand::new("open", arguments))
}

#[cfg(any(target_os = "linux", test))]
fn linux_worktree_commands(path: &str, target: &str) -> Result<Vec<DesktopCommand>, String> {
    match target {
        "vscode" => Ok(vec![DesktopCommand::new("code", vec![path.to_string()])]),
        "finder" => Ok(vec![DesktopCommand::new("xdg-open", vec![path.to_string()])]),
        "terminal" => Ok([
            DesktopCommand::new("xdg-terminal-exec", vec![format!("--dir={path}")]),
            DesktopCommand::in_directory("x-terminal-emulator", path),
            DesktopCommand::in_directory("gnome-terminal", path),
            DesktopCommand::in_directory("kgx", path),
            DesktopCommand::in_directory("konsole", path),
            DesktopCommand::in_directory("xfce4-terminal", path),
            DesktopCommand::in_directory("mate-terminal", path),
            DesktopCommand::in_directory("tilix", path),
            DesktopCommand::in_directory("alacritty", path),
            DesktopCommand::in_directory("kitty", path),
            DesktopCommand::in_directory("wezterm", path),
        ]
        .into()),
        _ => Err("Unknown worktree target.".to_string()),
    }
}

#[cfg(any(target_os = "linux", test))]
fn linux_url_command(url: String) -> DesktopCommand {
    DesktopCommand::new("xdg-open", vec![url])
}

#[cfg(any(target_os = "windows", test))]
fn windows_worktree_commands(path: &str, target: &str) -> Result<Vec<DesktopCommand>, String> {
    match target {
        "vscode" => Ok(vec![DesktopCommand::hidden("code.cmd", vec![path.to_string()])]),
        "finder" => Ok(vec![DesktopCommand::new("explorer.exe", vec![path.to_string()])]),
        "terminal" => Ok(vec![
            DesktopCommand::new("wt.exe", vec!["-d".to_string(), path.to_string()]),
            DesktopCommand::in_directory("powershell.exe", path),
            DesktopCommand::in_directory("cmd.exe", path),
        ]),
        _ => Err("Unknown worktree target.".to_string()),
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_url_command(url: String) -> DesktopCommand {
    DesktopCommand::new("explorer.exe", vec![url])
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn start_desktop_command(command: &DesktopCommand) -> Result<(), std::io::Error> {
    let mut process = desktop_process(command.program);
    #[cfg(target_os = "windows")]
    if command.hide_console {
        process.creation_flags(CREATE_NO_WINDOW);
    }
    process.args(&command.arguments);
    if let Some(path) = &command.current_dir {
        process.current_dir(path);
    }
    process.spawn().map(|mut child| {
        let _ = std::thread::spawn(move || {
            let _ = child.wait();
        });
    })
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn start_first_desktop_command(
    commands: Vec<DesktopCommand>,
    target: &str,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for command in commands {
        match start_desktop_command(&command) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => errors.push(command.program),
            Err(error) => return Err(format!("Could not open {target}: {error}")),
        }
    }
    Err(format!(
        "Could not find an application to open {target}. Tried: {}.",
        errors.join(", ")
    ))
}

#[cfg(target_os = "macos")]
fn run_desktop_command(command: &DesktopCommand) -> Result<(), String> {
    let mut process = external_command(command.program);
    process.args(&command.arguments);
    if let Some(path) = &command.current_dir {
        process.current_dir(path);
    }
    process
        .status()
        .map_err(|error| error.to_string())?
        .success()
        .then_some(())
        .ok_or_else(|| format!("Could not run {}.", command.program))
}

/// Launches a worktree in another local application. In server mode this runs on the host machine.
pub(crate) fn launch_worktree(path: &str, target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let command = macos_worktree_command(path, target)?;
        run_desktop_command(&command).map_err(|_| format!("Could not open {target}."))
    }
    #[cfg(target_os = "linux")]
    {
        start_first_desktop_command(linux_worktree_commands(path, target)?, target)
    }
    #[cfg(target_os = "windows")]
    {
        start_first_desktop_command(windows_worktree_commands(path, target)?, target)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (path, target);
        Err("Opening worktrees outside Git Nav is currently supported on macOS, Linux, and Windows only.".to_string())
    }
}

#[tauri::command]
pub(crate) fn open_url(url: String) -> Result<(), String> {
    if !is_https_url(&url) {
        return Err("Only https links can be opened.".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        run_desktop_command(&DesktopCommand::new("open", vec![url]))
            .map_err(|error| format!("Could not open the link: {error}"))
    }
    #[cfg(target_os = "linux")]
    {
        start_desktop_command(&linux_url_command(url))
            .map_err(|error| format!("Could not open the link: {error}"))
    }
    #[cfg(target_os = "windows")]
    {
        start_desktop_command(&windows_url_command(url))
            .map_err(|error| format!("Could not open the link: {error}"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err("Opening links outside Git Nav is currently supported on macOS, Linux, and Windows only.".to_string())
    }
}

fn is_https_url(url: &str) -> bool {
    url.starts_with("https://")
}

#[tauri::command(async)]
pub(crate) fn open_worktree(app: AppHandle, path: String, target: String) -> Result<(), String> {
    if target == "git-nav" {
        return open_repository_window(&app, &path);
    }
    launch_worktree(&path, &target)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::path::PathBuf;

    #[cfg(unix)]
    fn command_line_test_directory(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = env::temp_dir().join(format!(
            "git-nav-command-line-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    #[cfg(unix)]
    fn reports_a_command_line_link_that_is_not_there() {
        let directory = command_line_test_directory("reports_a_command_line_link_that_is_not_there");
        let link = directory.join("git-nav");

        assert_eq!(command_line_link_at(&link, Path::new("/apps/git-nav")).state, "missing");
    }

    #[test]
    #[cfg(unix)]
    fn reports_a_command_line_link_that_points_at_this_executable() {
        let directory = command_line_test_directory("reports_a_command_line_link_that_points_at_this_executable");
        let link = directory.join("git-nav");
        let executable = directory.join("Git Nav.app/Contents/MacOS/git-nav");
        std::os::unix::fs::symlink(&executable, &link).unwrap();

        assert_eq!(command_line_link_at(&link, &executable).state, "installed");
    }

    // An app that moved leaves the old link behind, and installing again is what repairs it.
    #[test]
    #[cfg(unix)]
    fn reports_a_command_line_link_left_by_another_copy() {
        let directory = command_line_test_directory("reports_a_command_line_link_left_by_another_copy");
        let link = directory.join("git-nav");
        std::os::unix::fs::symlink(directory.join("elsewhere/git-nav"), &link).unwrap();

        assert_eq!(
            command_line_link_at(&link, &directory.join("Git Nav.app/Contents/MacOS/git-nav")).state,
            "elsewhere"
        );
    }

    #[test]
    fn constructs_macos_worktree_commands() {
        assert_eq!(
            macos_worktree_command("/workspace/git-nav", "vscode"),
            Ok(DesktopCommand::new(
                "open",
                vec![
                    "-a".to_string(),
                    "Visual Studio Code".to_string(),
                    "/workspace/git-nav".to_string(),
                ],
            ))
        );
    }

    #[test]
    fn constructs_linux_worktree_commands() {
        let commands = linux_worktree_commands("/workspace/git-nav", "terminal").unwrap();

        assert_eq!(
            commands.first(),
            Some(&DesktopCommand::new(
                "xdg-terminal-exec",
                vec!["--dir=/workspace/git-nav".to_string()],
            ))
        );
        assert!(commands.iter().skip(1).all(|command| {
            command.arguments.is_empty()
                && command.current_dir.as_deref() == Some("/workspace/git-nav")
        }));
    }

    #[test]
    fn constructs_linux_url_commands() {
        assert_eq!(
            linux_url_command("https://github.com/sangonz193/git-nav".to_string()),
            DesktopCommand::new(
                "xdg-open",
                vec!["https://github.com/sangonz193/git-nav".to_string()],
            )
        );
    }

    #[test]
    fn constructs_windows_worktree_commands() {
        let path = "C:\\workspace\\git-nav";

        assert_eq!(
            windows_worktree_commands(path, "vscode"),
            Ok(vec![DesktopCommand::hidden("code.cmd", vec![path.to_string()])])
        );
        assert_eq!(
            windows_worktree_commands(path, "finder"),
            Ok(vec![DesktopCommand::new("explorer.exe", vec![path.to_string()])])
        );
        assert_eq!(
            windows_worktree_commands(path, "terminal"),
            Ok(vec![
                DesktopCommand::new("wt.exe", vec!["-d".to_string(), path.to_string()]),
                DesktopCommand::in_directory("powershell.exe", path),
                DesktopCommand::in_directory("cmd.exe", path),
            ])
        );
    }

    #[test]
    fn constructs_windows_url_commands() {
        assert_eq!(
            windows_url_command("https://github.com/sangonz193/git-nav".to_string()),
            DesktopCommand::new(
                "explorer.exe",
                vec!["https://github.com/sangonz193/git-nav".to_string()],
            )
        );
    }

    #[test]
    fn only_accepts_https_urls() {
        assert!(is_https_url("https://github.com/sangonz193/git-nav"));
        assert!(!is_https_url("http://github.com/sangonz193/git-nav"));
        assert!(!is_https_url("file:///workspace/git-nav"));
    }
}
