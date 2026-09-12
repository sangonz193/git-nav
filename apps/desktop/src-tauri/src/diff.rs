use base64::Engine;
use serde::Serialize;
use std::{collections::{HashMap, HashSet}, fs, io::Read, path::Path};
use crate::git::{WORKTREE_REF, git_output, git_output_allow_empty, git_output_bytes, git_result, worktree_path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangedFile {
    pub(crate) status: String,
    pub(crate) old_path: Option<String>,
    pub(crate) new_path: Option<String>,
    pub(crate) old_oid: Option<String>,
    pub(crate) new_oid: Option<String>,
    pub(crate) additions: u32,
    pub(crate) deletions: u32,
    pub(crate) is_binary: bool,
    pub(crate) split_rows: u32,
    pub(crate) unified_rows: u32,
    pub(crate) hunk_rows: u32,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct FileStat {
    additions: u32,
    deletions: u32,
    is_binary: bool,
    split_rows: u32,
    unified_rows: u32,
    hunk_rows: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileDiff {
    pub(crate) old_file_name: Option<String>,
    pub(crate) new_file_name: Option<String>,
    pub(crate) old_content: Option<String>,
    pub(crate) new_content: Option<String>,
    pub(crate) hunks: Vec<String>,
    pub(crate) is_binary: bool,
    pub(crate) old_binary: Option<BinaryContent>,
    pub(crate) new_binary: Option<BinaryContent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BinaryContent {
    pub(crate) size: u64,
    pub(crate) image: Option<String>,
}

/// Counts the rows `@git-diff-view` renders for one file: every patch body line becomes a unified
/// row, while split mode pairs a run of deletions with the additions that follow it.
fn parse_patch_stats(patch: &str) -> Vec<FileStat> {
    let mut files: Vec<FileStat> = Vec::new();
    let (mut deletions, mut additions) = (0u32, 0u32);
    for line in patch.lines() {
        let ends_block = !matches!(line.as_bytes().first(), Some(b'+') | Some(b'\\'))
            && !(line.starts_with('-') && additions == 0);
        if let Some(file) = files.last_mut().filter(|_| ends_block) {
            file.split_rows += deletions.max(additions);
            file.additions += additions;
            file.deletions += deletions;
            deletions = 0;
            additions = 0;
        }
        if line.starts_with("diff --git ") {
            files.push(FileStat::default());
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            file.is_binary = true;
            continue;
        }
        if line.starts_with("@@ ") {
            file.hunk_rows += 1;
            continue;
        }
        if file.hunk_rows == 0 {
            continue;
        }
        match line.as_bytes().first() {
            Some(b'+') => {
                additions += 1;
                file.unified_rows += 1;
            }
            Some(b'-') => {
                deletions += 1;
                file.unified_rows += 1;
            }
            Some(b'\\') => {}
            _ => {
                file.split_rows += 1;
                file.unified_rows += 1;
            }
        }
    }
    if let Some(file) = files.last_mut() {
        file.split_rows += deletions.max(additions);
        file.additions += additions;
        file.deletions += deletions;
    }
    for file in &mut files {
        // The view closes every file that still hides lines with one more expandable row.
        if file.hunk_rows > 0 {
            file.hunk_rows += 1;
        }
    }
    files
}

// --raw carries the blob each side of a file is, which is what a file being marked as read is read at.
const RAW_ARGUMENTS: [&str; 7] = ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--raw", "--abbrev=40", "-z"];
const PATCH_ARGUMENTS: [&str; 6] = ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--no-color", "--unified=3"];

const NUMSTAT_ARGUMENTS: [&str; 6] = ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--numstat", "-z"];
const NAME_STATUS_ARGUMENTS: [&str; 6] = ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--name-status", "-z"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffStatFile {
    path: String,
    old_path: Option<String>,
    // The letter git gives the change: A, M, D, R, C or T.
    status: Option<String>,
    // A binary file has no line counts.
    additions: Option<u32>,
    deletions: Option<u32>,
}

fn parse_numstat(output: &[u8]) -> Vec<DiffStatFile> {
    let mut fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned());
    let mut files = Vec::new();
    while let Some(record) = fields.next() {
        let mut columns = record.splitn(3, '\t');
        let additions = columns.next().and_then(|count| count.parse().ok());
        let deletions = columns.next().and_then(|count| count.parse().ok());
        // A rename carries its two paths in the fields following the counts.
        let (old_path, path) = match columns.next() {
            Some(path) if !path.is_empty() => (None, path.to_string()),
            _ => {
                let Some(old_path) = fields.next() else { break };
                let Some(path) = fields.next() else { break };
                (Some(old_path), path)
            }
        };
        files.push(DiffStatFile { path, old_path, status: None, additions, deletions });
    }
    files
}

// "M\0path\0" for most changes; a rename or copy carries a score and both paths, "R100\0old\0new\0".
fn parse_name_status(output: &[u8]) -> HashMap<String, String> {
    let mut fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned());
    let mut statuses = HashMap::new();
    while let Some(status) = fields.next() {
        let Some(first_path) = fields.next() else {
            break;
        };
        let letter = status.chars().next().unwrap_or_default().to_string();
        let path = if matches!(letter.as_str(), "R" | "C") {
            let Some(new_path) = fields.next() else { break };
            new_path
        } else {
            first_path
        };
        statuses.insert(path, letter);
    }
    statuses
}

fn whitespace_arguments(ignore_whitespace: bool) -> &'static [&'static str] {
    if ignore_whitespace {
        &["--ignore-all-space"]
    } else {
        &[]
    }
}

// Only the patch answers to --ignore-all-space; --raw lists a file whenever its two blobs differ, however
// they differ. Numstat is the patch's own machinery, so the files it names are the ones the patch carries.
fn files_changed_beyond_whitespace(path: &str, revisions: &[&str]) -> Result<HashSet<String>, String> {
    let output = git_output_bytes(path, &[&NUMSTAT_ARGUMENTS[..], whitespace_arguments(true), revisions].concat())
        .ok_or_else(|| "git diff failed.".to_string())?;
    Ok(parse_numstat(&output)
        .into_iter()
        .flat_map(|file| file.old_path.into_iter().chain(std::iter::once(file.path)))
        .collect())
}

// A blob of nothing is what git reports for a side a file does not have, and for a working tree file it
// has not been asked to hash.
fn blob_oid(oid: &str) -> Option<String> {
    oid.chars().any(|character| character != '0').then(|| oid.to_string())
}

fn parse_changed_files(raw: &[u8], patch: &str, kept: Option<&HashSet<String>>) -> Result<Vec<ChangedFile>, String> {
    // The patch lists files in the same order as --raw, so its per-file stats zip by index.
    let stats = parse_patch_stats(patch);
    let fields = raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8(field.to_vec()).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut files = Vec::new();
    let mut index = 0;
    while let Some(record) = fields.get(index) {
        index += 1;
        // ":<old mode> <new mode> <old blob> <new blob> <status>"
        let [_, _, old_oid, new_oid, status] = record.trim_start_matches(':').split(' ').collect::<Vec<_>>()[..] else {
            return Err("Invalid git diff record.".to_string());
        };
        let (old_oid, new_oid) = (blob_oid(old_oid), blob_oid(new_oid));
        let kind = status.chars().next().ok_or_else(|| "Invalid git diff status.".to_string())?;
        let first_path = fields.get(index).ok_or_else(|| "Invalid git diff path.".to_string())?.clone();
        index += 1;
        let (old_path, new_path, status) = match kind {
            'A' => (None, Some(first_path), "added"),
            'D' => (Some(first_path), None, "deleted"),
            'R' => {
                let new_path = fields.get(index).ok_or_else(|| "Invalid renamed path.".to_string())?.clone();
                index += 1;
                (Some(first_path), Some(new_path), "renamed")
            }
            'C' => {
                let new_path = fields.get(index).ok_or_else(|| "Invalid copied path.".to_string())?.clone();
                index += 1;
                (Some(first_path), Some(new_path), "copied")
            }
            _ => (Some(first_path.clone()), Some(first_path), "modified"),
        };
        if kept.is_some_and(|kept| !new_path.as_ref().or(old_path.as_ref()).is_some_and(|name| kept.contains(name))) {
            continue;
        }
        let stat = stats.get(files.len()).copied().unwrap_or_default();
        files.push(ChangedFile {
            status: status.to_string(),
            old_path,
            new_path,
            old_oid,
            new_oid,
            additions: stat.additions,
            deletions: stat.deletions,
            is_binary: stat.is_binary,
            split_rows: stat.split_rows,
            unified_rows: stat.unified_rows,
            hunk_rows: stat.hunk_rows,
        });
    }
    Ok(files)
}

pub(crate) fn changed_files(path: &str, base_sha: &str, head_sha: &str, ignore_whitespace: bool) -> Result<Vec<ChangedFile>, String> {
    let revisions = [base_sha, head_sha];
    let whitespace = whitespace_arguments(ignore_whitespace);
    let raw = git_output_bytes(path, &[&RAW_ARGUMENTS[..], &revisions].concat())
        .ok_or_else(|| "git diff failed.".to_string())?;
    let patch = git_output_allow_empty(path, &[&PATCH_ARGUMENTS[..], whitespace, &revisions].concat())?;
    let kept = ignore_whitespace.then(|| files_changed_beyond_whitespace(path, &revisions)).transpose()?;
    parse_changed_files(&raw, &patch, kept.as_ref())
}

// Untracked files are invisible to git diff, so they are listed separately and appended after the
// tracked changes, where they cannot disturb the index the patch stats are zipped by.
pub(crate) fn untracked_files(path: &str) -> Result<Vec<ChangedFile>, String> {
    let output = git_output_bytes(path, &["ls-files", "--others", "--exclude-standard", "-z"])
        .ok_or_else(|| "git ls-files failed.".to_string())?;
    let root = worktree_path(path)?;
    let mut files = Vec::new();
    for field in output.split(|byte| *byte == 0).filter(|field| !field.is_empty()) {
        let name = String::from_utf8(field.to_vec()).map_err(|error| error.to_string())?;
        let contents = fs::read(Path::new(&root).join(&name)).unwrap_or_default();
        let is_binary = contents.contains(&0);
        let lines = if is_binary || contents.is_empty() {
            0
        } else {
            let newlines = contents.iter().filter(|byte| **byte == b'\n').count() as u32;
            newlines + u32::from(contents.last() != Some(&b'\n'))
        };
        files.push(ChangedFile {
            status: "added".to_string(),
            old_path: None,
            new_path: Some(name),
            old_oid: None,
            new_oid: None,
            additions: lines,
            deletions: 0,
            is_binary,
            split_rows: lines,
            unified_rows: lines,
            hunk_rows: u32::from(lines > 0),
        });
    }
    Ok(files)
}

pub(crate) fn worktree_changed_files(path: &str, base_sha: &str, ignore_whitespace: bool) -> Result<Vec<ChangedFile>, String> {
    let revisions = [base_sha];
    let whitespace = whitespace_arguments(ignore_whitespace);
    let raw = git_output_bytes(path, &[&RAW_ARGUMENTS[..], &revisions].concat())
        .ok_or_else(|| "git diff failed.".to_string())?;
    let patch = git_output_allow_empty(path, &[&PATCH_ARGUMENTS[..], whitespace, &revisions].concat())?;
    let kept = ignore_whitespace.then(|| files_changed_beyond_whitespace(path, &revisions)).transpose()?;
    let mut files = parse_changed_files(&raw, &patch, kept.as_ref())?;
    files.extend(untracked_files(path)?);
    Ok(files)
}

// git diff cannot see an untracked file, so an empty patch means falling back to an empty left side.
fn worktree_patch(repo_path: &str, base_sha: &str, path: &str, ignore_whitespace: bool) -> Result<String, String> {
    let whitespace = whitespace_arguments(ignore_whitespace);
    let patch = git_output_allow_empty(repo_path, &[&PATCH_ARGUMENTS[..], whitespace, &[base_sha, "--", path]].concat())?;
    if !patch.is_empty() {
        return Ok(patch);
    }
    // --no-index reports a difference by exiting non-zero, so its status carries no error to report.
    let output = git_result(repo_path, &[&PATCH_ARGUMENTS[..], whitespace, &["--no-index", "--", "/dev/null", path]].concat())?;
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

fn file_diff(
    repo_path: &str,
    base_sha: &str,
    head_sha: &str,
    old_path: Option<String>,
    new_path: Option<String>,
    ignore_whitespace: bool,
) -> Result<FileDiff, String> {
    let path = new_path.as_ref().or(old_path.as_ref()).ok_or_else(|| "No file path was provided.".to_string())?;
    let is_worktree = head_sha == WORKTREE_REF;
    let patch = if is_worktree {
        worktree_patch(repo_path, base_sha, path, ignore_whitespace)?
    } else {
        git_output_allow_empty(repo_path, &[&PATCH_ARGUMENTS[..], whitespace_arguments(ignore_whitespace), &[base_sha, head_sha, "--", path]].concat())?
    };
    // Content lines in a patch always carry a leading marker, so an unprefixed header is git's own.
    if patch.lines().any(|line| line.starts_with("Binary files ") || line == "GIT binary patch") {
        let old_binary = old_path
            .as_ref()
            .map(|path| git_binary_content(repo_path, base_sha, path))
            .transpose()?;
        let new_binary = if is_worktree {
            let root = worktree_path(repo_path)?;
            new_path
                .as_ref()
                .map(|path| worktree_binary_content(&root, path))
                .transpose()?
        } else {
            new_path
                .as_ref()
                .map(|path| git_binary_content(repo_path, head_sha, path))
                .transpose()?
        };
        return Ok(FileDiff {
            old_binary,
            new_binary,
            old_file_name: old_path,
            new_file_name: new_path,
            old_content: None,
            new_content: None,
            hunks: Vec::new(),
            is_binary: true,
        });
    }

    let old_content = old_path.as_ref().map(|path| git_output_allow_empty(repo_path, &["show", &format!("{base_sha}:{path}")])).transpose()?;
    let new_content = if is_worktree {
        let root = worktree_path(repo_path)?;
        new_path.as_ref().map(|path| fs::read_to_string(Path::new(&root).join(path)).map_err(|error| error.to_string())).transpose()?
    } else {
        new_path.as_ref().map(|path| git_output_allow_empty(repo_path, &["show", &format!("{head_sha}:{path}")])).transpose()?
    };

    Ok(FileDiff {
        old_file_name: old_path,
        new_file_name: new_path,
        old_content,
        new_content,
        hunks: (!patch.is_empty()).then_some(vec![patch]).unwrap_or_default(),
        is_binary: false,
        old_binary: None,
        new_binary: None,
    })
}

pub(crate) const IMAGE_PREVIEW_LIMIT: usize = 8 * 1024 * 1024;

fn image_mime_type(path: &str) -> Option<&'static str> {
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

fn binary_content(path: &str, size: u64, bytes: Option<Vec<u8>>) -> BinaryContent {
    let image = image_mime_type(path).and_then(|mime| {
        bytes.map(|bytes| format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    });
    BinaryContent { size, image }
}

fn git_binary_content(repo_path: &str, sha: &str, path: &str) -> Result<BinaryContent, String> {
    let object = format!("{sha}:{path}");
    let size = git_output(repo_path, &["cat-file", "-s", &object])
        .ok_or_else(|| format!("Could not read {path} at {sha}."))?
        .parse()
        .map_err(|error: std::num::ParseIntError| error.to_string())?;
    let bytes = image_mime_type(path)
        .filter(|_| size <= IMAGE_PREVIEW_LIMIT as u64)
        .map(|_| git_output_bytes(repo_path, &["show", &object]).ok_or_else(|| format!("Could not read {path} at {sha}.")))
        .transpose()?;
    Ok(binary_content(path, size, bytes))
}

fn worktree_binary_content(root: &str, path: &str) -> Result<BinaryContent, String> {
    let file = Path::new(root).join(path);
    let symlink_metadata = fs::symlink_metadata(&file).map_err(|error| error.to_string())?;
    if symlink_metadata.file_type().is_symlink() {
        return Ok(binary_content(path, symlink_metadata.len(), None));
    }
    let file = fs::File::open(file).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    let size = metadata.len();
    let bytes = metadata.file_type().is_file().then_some(())
        .and(image_mime_type(path))
        .filter(|_| size <= IMAGE_PREVIEW_LIMIT as u64)
        .map(|_| {
            let mut bytes = Vec::new();
            file.take(IMAGE_PREVIEW_LIMIT as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            Ok::<_, String>(bytes)
        })
        .transpose()?
        .filter(|bytes| bytes.len() <= IMAGE_PREVIEW_LIMIT);
    Ok(binary_content(path, size, bytes))
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn diff_file(
    repo_path: String,
    base_sha: String,
    head_sha: String,
    old_path: Option<String>,
    new_path: Option<String>,
    ignore_whitespace: bool,
) -> Result<FileDiff, String> {
    file_diff(&repo_path, &base_sha, &head_sha, old_path, new_path, ignore_whitespace)
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn diff_stat(repo_path: String, base: String, head: String) -> Result<Vec<DiffStatFile>, String> {
    let base = crate::git::resolve_commit(&repo_path, &base)?;
    let head = crate::git::resolve_commit(&repo_path, &head)?;
    let revisions = [base.as_str(), head.as_str()];
    let numstat = git_output_bytes(&repo_path, &[&NUMSTAT_ARGUMENTS[..], &revisions].concat())
        .ok_or_else(|| "git diff failed.".to_string())?;
    let name_status = git_output_bytes(&repo_path, &[&NAME_STATUS_ARGUMENTS[..], &revisions].concat())
        .ok_or_else(|| "git diff failed.".to_string())?;
    let mut statuses = parse_name_status(&name_status);
    Ok(parse_numstat(&numstat)
        .into_iter()
        .map(|file| DiffStatFile { status: statuses.remove(&file.path), ..file })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_counts_renames_and_binaries_from_numstat() {
        let files = parse_numstat(b"3\t1\tsrc/a.rs\0-\t-\timage.png\00\t0\t\0old.txt\0new.txt\0");

        assert_eq!(files.len(), 3);
        assert_eq!((files[0].path.as_str(), files[0].additions, files[0].deletions), ("src/a.rs", Some(3), Some(1)));
        assert_eq!((files[1].path.as_str(), files[1].additions, files[1].deletions), ("image.png", None, None));
        assert_eq!(files[2].old_path.as_deref(), Some("old.txt"));
        assert_eq!(files[2].path, "new.txt");
    }

    #[test]
    fn reads_the_status_letter_of_each_changed_path() {
        let statuses = parse_name_status(b"M\0src/a.rs\0A\0image.png\0R100\0old.txt\0new.txt\0D\0gone.txt\0");

        assert_eq!(statuses.get("src/a.rs").map(String::as_str), Some("M"));
        assert_eq!(statuses.get("image.png").map(String::as_str), Some("A"));
        assert_eq!(statuses.get("new.txt").map(String::as_str), Some("R"));
        assert_eq!(statuses.get("gone.txt").map(String::as_str), Some("D"));
        assert_eq!(statuses.len(), 4);
    }

    #[test]
    fn counts_the_rows_each_file_of_a_patch_renders() {
        let stats = parse_patch_stats(concat!(
            "diff --git a/src/main.rs b/src/main.rs\n",
            "--- a/src/main.rs\n",
            "+++ b/src/main.rs\n",
            "@@ -1,5 +1,5 @@\n",
            " context\n",
            "-old one\n",
            "-old two\n",
            "+new one\n",
            " context\n",
            "@@ -20,3 +20,4 @@\n",
            " context\n",
            "+added\n",
            "diff --git a/logo.png b/logo.png\n",
            "Binary files a/logo.png and b/logo.png differ\n",
        ));

        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].additions, 2);
        assert_eq!(stats[0].deletions, 2);
        // Three context rows, a paired two-for-one replacement, and a lone addition.
        assert_eq!(stats[0].split_rows, 6);
        assert_eq!(stats[0].unified_rows, 7);
        assert_eq!(stats[0].hunk_rows, 3);
        assert!(stats[1].is_binary);
        assert_eq!(stats[1].hunk_rows, 0);
    }

    #[test]
    fn reads_the_blob_each_side_of_a_changed_file_is() {
        let raw = b":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 M\0src/main.rs\0:000000 100644 0000000000000000000000000000000000000000 3333333333333333333333333333333333333333 A\0src/new.rs\0:100644 100644 4444444444444444444444444444444444444444 5555555555555555555555555555555555555555 R100\0src/old.rs\0src/renamed.rs\0";

        let files = parse_changed_files(raw, "", None).unwrap();

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[0].old_oid.as_deref(), Some("1".repeat(40).as_str()));
        assert_eq!(files[0].new_oid.as_deref(), Some("2".repeat(40).as_str()));
        assert_eq!(files[1].status, "added");
        assert_eq!(files[1].old_oid, None);
        assert_eq!(files[1].new_path.as_deref(), Some("src/new.rs"));
        assert_eq!(files[2].status, "renamed");
        assert_eq!(files[2].old_path.as_deref(), Some("src/old.rs"));
        assert_eq!(files[2].new_path.as_deref(), Some("src/renamed.rs"));
        assert_eq!(files[2].new_oid.as_deref(), Some("5".repeat(40).as_str()));
    }
}
