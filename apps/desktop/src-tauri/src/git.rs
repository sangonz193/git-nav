use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap, collections::HashSet, fs, io::Write, path::Path, path::PathBuf,
    process::Child, process::Output, process::Stdio,
};
use crate::process::external_command;

// Not legal ref names, so they cannot collide with anything the user could name a branch or tag.
pub(crate) const WORKTREE_REF: &str = ":worktree";
pub(crate) const EMPTY_TREE_REF: &str = ":empty-tree";
pub(crate) const INDEX_REF: &str = ":index";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefUpdate {
    pub(crate) reference: String,
    pub(crate) before: String,
    pub(crate) after: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompletedOperation {
    pub(crate) summary: String,
    pub(crate) updates: Vec<RefUpdate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FailedOperation {
    pub(crate) message: String,
    pub(crate) files: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub(crate) enum OperationResult {
    Completed(CompletedOperation),
    Failed(FailedOperation),
}

pub(crate) fn git_output(path: &str, arguments: &[&str]) -> Option<String> {
    let output = external_command("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

pub(crate) fn git_output_bytes(path: &str, arguments: &[&str]) -> Option<Vec<u8>> {
    let output = external_command("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .output()
        .ok()?;

    output.status.success().then_some(output.stdout)
}

pub(crate) fn git_output_allow_empty(path: &str, arguments: &[&str]) -> Result<String, String> {
    let output = external_command("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

pub(crate) fn resolve_commit(path: &str, reference: &str) -> Result<String, String> {
    let revision = format!("{reference}^{{commit}}");
    git_output_allow_empty(path, &["rev-parse", "--verify", "--end-of-options", &revision])
        .map(|value| value.trim().to_string())
        .and_then(|value| (!value.is_empty()).then_some(value).ok_or_else(|| format!("Could not resolve {reference}.")))
}

pub(crate) fn resolve_diff_base(path: &str, reference: &str, head_sha: &str) -> Result<String, String> {
    if reference == EMPTY_TREE_REF {
        if git_output_allow_empty(path, &["rev-parse", "--is-shallow-repository"])?.trim() == "true" {
            let shallow_path = git_output_allow_empty(path, &["rev-parse", "--git-path", "shallow"])?;
            let shallow_path = PathBuf::from(shallow_path.trim());
            let shallow_path = if shallow_path.is_absolute() { shallow_path } else { Path::new(path).join(shallow_path) };
            let shallow_boundaries = fs::read_to_string(shallow_path).map_err(|error| error.to_string())?;
            let shallow_boundaries: HashSet<_> = shallow_boundaries.lines().collect();
            let roots = git_output_allow_empty(path, &["rev-list", "--max-parents=0", head_sha])?;
            for root in roots.lines().filter(|root| shallow_boundaries.contains(root)) {
                let commit = git_output_allow_empty(path, &["cat-file", "commit", root])?;
                if commit.lines().take_while(|line| !line.is_empty()).any(|line| line.starts_with("parent ")) {
                    let short_sha = git_output_allow_empty(path, &["rev-parse", "--short", root])?.trim().to_string();
                    return Err(format!("{short_sha} is the edge of a shallow clone; its parent has not been fetched."));
                }
            }
        }
        return git_output_allow_empty(path, &["hash-object", "-t", "tree", "--stdin"])
            .map(|value| value.trim().to_string())
            .and_then(|value| (!value.is_empty()).then_some(value).ok_or_else(|| "Could not resolve the empty tree.".to_string()));
    }
    resolve_commit(path, reference)
}

pub(crate) fn primary_reference(path: &str) -> Result<String, String> {
    if let Some(reference) = git_output(path, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
        if resolve_commit(path, &reference).is_ok() {
            return Ok(reference);
        }
    }
    for reference in ["main", "master", "HEAD"] {
        if resolve_commit(path, reference).is_ok() {
            return Ok(reference.to_string());
        }
    }
    Err("Could not identify the primary branch.".to_string())
}

pub(crate) fn worktree_path(path: &str) -> Result<String, String> {
    git_output(path, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| "Choose a Git repository.".to_string())
}

pub(crate) fn project_id(path: &str) -> Result<String, String> {
    let worktree_path = worktree_path(path)?;
    let common_dir = git_output(&worktree_path, &["rev-parse", "--git-common-dir"])
        .ok_or_else(|| "Could not identify the Git project.".to_string())?;
    let common_dir = PathBuf::from(common_dir);
    let common_dir = if common_dir.is_absolute() {
        common_dir
    } else {
        PathBuf::from(worktree_path).join(common_dir)
    };

    fs::canonicalize(common_dir)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

pub(crate) fn worktree_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string()
}

pub(crate) fn git_succeeds(path: &str, arguments: &[&str]) -> bool {
    external_command("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .status()
        .is_ok_and(|status| status.success())
}

// A `Child` that is dropped without a wait stays a zombie for the lifetime of the app, so every
// spawn that is abandoned early - a killed walk, a `?` on a parse failure - is reaped here instead.
pub(crate) struct ChildGuard(pub(crate) Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(crate) fn patch_id(repo_path: &str, arguments: &[&str]) -> Option<String> {
    let mut diff = ChildGuard(
        external_command("git")
            .arg("-C")
            .arg(repo_path)
            .args(arguments)
            .stdout(Stdio::piped())
            .spawn()
            .ok()?,
    );
    let stdout = diff.0.stdout.take()?;
    let output = external_command("git")
        .arg("-C")
        .arg(repo_path)
        .args(["patch-id", "--stable"])
        .stdin(stdout)
        .output()
        .ok()?;
    let value = String::from_utf8(output.stdout).ok()?;
    value.split_whitespace().next().map(str::to_string)
}

pub(crate) fn git_result(path: &str, arguments: &[&str]) -> Result<Output, String> {
    external_command("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| error.to_string())
}

pub(crate) fn git_result_with_stdin(path: &str, arguments: &[&str], stdin: &[u8]) -> Result<Output, String> {
    let mut child = external_command("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let write_error = child.stdin.take().and_then(|mut pipe| pipe.write_all(stdin).err());
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if let Some(error) = write_error {
        if !output.status.success() {
            return Err(git_error_message(&output));
        }
        return Err(error.to_string());
    }
    Ok(output)
}

fn parse_git_version(output: &str) -> Option<(u32, u32)> {
    let mut parts = output.split_whitespace().nth(2)?.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

pub(crate) fn git_version(path: &str) -> Option<(u32, u32)> {
    git_output(path, &["--version"]).as_deref().and_then(parse_git_version)
}

fn parse_ref_shas(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| line.split_once('\0'))
        .map(|(reference, sha)| (reference.to_string(), sha.to_string()))
        .collect()
}

pub(crate) fn ref_shas(repo_path: &str) -> Result<HashMap<String, String>, String> {
    git_output_allow_empty(
        repo_path,
        &["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags", "refs/remotes"],
    )
    .map(|output| parse_ref_shas(&output))
}

pub(crate) fn changed_refs(before: &HashMap<String, String>, after: &HashMap<String, String>) -> Vec<RefUpdate> {
    let mut updates: Vec<_> = before
        .keys()
        .chain(after.keys())
        .collect::<HashSet<_>>()
        .into_iter()
        .filter_map(|reference| {
            let was = before.get(reference).cloned().unwrap_or_default();
            let now = after.get(reference).cloned().unwrap_or_default();
            (was != now).then(|| RefUpdate {
                reference: reference.clone(),
                before: was,
                after: now,
            })
        })
        .collect();
    updates.sort_by(|left, right| left.reference.cmp(&right.reference));
    updates
}

fn conflicted_files(worktree: &str) -> Vec<String> {
    git_output_allow_empty(worktree, &["diff", "--name-only", "--diff-filter=U"])
        .map(|output| output.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

pub(crate) fn failed_operation(worktree: &str, output: &Output) -> OperationResult {
    OperationResult::Failed(FailedOperation {
        files: conflicted_files(worktree),
        message: git_error_message(output),
    })
}

pub(crate) fn completed_operation(repo_path: &str, summary: String, before: &HashMap<String, String>) -> Result<OperationResult, String> {
    Ok(OperationResult::Completed(CompletedOperation {
        summary,
        updates: changed_refs(before, &ref_shas(repo_path)?),
    }))
}

pub(crate) fn git_error_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        "Git exited without a message.".to_string()
    } else {
        stdout
    }
}

pub(crate) fn is_ancestor(repo_path: &str, ancestor: &str, descendant: &str) -> bool {
    git_result(repo_path, &["merge-base", "--is-ancestor", ancestor, descendant])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(target_os = "windows"))]
    use std::process::Command;
    #[cfg(not(target_os = "windows"))]
    use crate::graph::walk_commit_graph_page;
    use crate::test_support::scratch_repository;

    #[test]
    fn reads_the_major_and_minor_git_version() {
        assert_eq!(parse_git_version("git version 2.50.1 (Apple Git-155)"), Some((2, 50)));
        assert_eq!(parse_git_version("git version 2.39.5"), Some((2, 39)));
        assert_eq!(parse_git_version("not git"), None);
    }

    #[test]
    fn reports_the_refs_an_operation_moved_created_and_deleted() {
        let before = parse_ref_shas("refs/heads/main\0aaa\nrefs/heads/topic\0bbb\nrefs/heads/other\0ccc");
        let after = parse_ref_shas("refs/heads/main\0aaa\nrefs/heads/topic\0ddd\nrefs/tags/v1\0eee");

        let updates = changed_refs(&before, &after);

        assert_eq!(updates.len(), 3);
        assert_eq!(updates[0].reference, "refs/heads/other");
        assert_eq!((updates[0].before.as_str(), updates[0].after.as_str()), ("ccc", ""));
        assert_eq!(updates[1].reference, "refs/heads/topic");
        assert_eq!((updates[1].before.as_str(), updates[1].after.as_str()), ("bbb", "ddd"));
        assert_eq!(updates[2].reference, "refs/tags/v1");
        assert_eq!((updates[2].before.as_str(), updates[2].after.as_str()), ("", "eee"));
    }

    #[cfg(not(target_os = "windows"))]
    fn zombie_children() -> usize {
        let pid = std::process::id().to_string();
        let output = Command::new("ps").args(["-ax", "-o", "ppid=,stat="]).output().unwrap();
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| {
                let mut fields = line.split_whitespace();
                fields.next() == Some(pid.as_str()) && fields.next().is_some_and(|stat| stat.starts_with('Z'))
            })
            .count()
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn reaps_the_git_processes_a_graph_walk_leaves_behind() {
        let (path, run) = scratch_repository("graph-reaping");
        run(&["commit", "--quiet", "--allow-empty", "--message", "first"]);
        fs::write(Path::new(&path).join("tracked.txt"), "contents\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "second"]);

        walk_commit_graph_page(&path, 0, 1, |_| Ok(())).unwrap();
        walk_commit_graph_page(&path, 0, usize::MAX, |_| Err("the receiver is gone".to_string())).unwrap_err();
        patch_id(&path, &["show", "HEAD"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        // Tests share a process, so a parallel case can hold a child of its own for an instant.
        let mut remaining = zombie_children();
        for _ in 0..20 {
            if remaining == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
            remaining = zombie_children();
        }
        assert_eq!(remaining, 0);
    }
}
