use std::{env, fs};

use crate::git::git_result;

pub(crate) fn scratch_repository(name: &str) -> (String, impl Fn(&[&str])) {
    let path = env::temp_dir()
        .join(format!("git-nav-{name}-{}", std::process::id()))
        .to_string_lossy()
        .into_owned();
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    let run_path = path.clone();
    let run = move |arguments: &[&str]| {
        let output = git_result(&run_path, arguments).unwrap();
        assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
    };
    run(&["init", "--quiet", "--initial-branch=main"]);
    run(&["config", "user.email", "tests@example.com"]);
    run(&["config", "user.name", "Tests"]);
    run(&["config", "commit.gpgsign", "false"]);
    run(&["config", "core.autocrlf", "false"]);
    (path, run)
}

pub(crate) fn remove_scratch_repository(path: &str) {
    for attempt in 0..20 {
        match fs::remove_dir_all(path) {
            Ok(()) => return,
            Err(error)
                if cfg!(target_os = "windows")
                    && error.raw_os_error() == Some(32)
                    && attempt < 19 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => panic!("Could not remove scratch repository: {error}"),
        }
    }
}

pub(crate) fn rerun_with_explicit_bare_repositories(test: &str) -> bool {
    if env::var("GIT_CONFIG_KEY_0").is_ok_and(|key| key == "safe.bareRepository") {
        return false;
    }
    let output = std::process::Command::new(env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "safe.bareRepository")
        .env("GIT_CONFIG_VALUE_0", "explicit")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success() && stdout.contains(" 1 passed"), "{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
    true
}
