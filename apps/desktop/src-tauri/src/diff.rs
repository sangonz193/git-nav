use base64::Engine;
use serde::Serialize;
use std::{collections::HashSet, fs, io::Read, path::Path};
use crate::git::{
    INDEX_REF, WORKTREE_REF, git_error_message, git_output, git_output_allow_empty, git_output_bytes, git_result,
    resolve_diff_base, worktree_path,
};

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

fn finish_patch_block(files: &mut [FileStat], deletions: &mut u32, additions: &mut u32) {
    if let Some(file) = files.last_mut() {
        file.split_rows += (*deletions).max(*additions);
        file.additions += *additions;
        file.deletions += *deletions;
        *deletions = 0;
        *additions = 0;
    }
}

/// Counts the rows `@git-diff-view` renders for one file: every patch body line becomes a unified
/// row, while split mode pairs a run of deletions with the additions that follow it.
fn parse_patch_stats(patch: &str) -> Vec<FileStat> {
    let mut files: Vec<FileStat> = Vec::new();
    let (mut deletions, mut additions) = (0u32, 0u32);
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            finish_patch_block(&mut files, &mut deletions, &mut additions);
            files.push(FileStat::default());
            continue;
        }
        let ends_block = !matches!(line.as_bytes().first(), Some(b'+') | Some(b'\\'))
            && !(line.starts_with('-') && additions == 0);
        if ends_block {
            finish_patch_block(&mut files, &mut deletions, &mut additions);
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
    finish_patch_block(&mut files, &mut deletions, &mut additions);
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
const DIFF_STAT_ARGUMENTS: [&str; 8] = ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--raw", "--abbrev=40", "--numstat", "-z"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffStatFile {
    path: String,
    old_path: Option<String>,
    status: String,
    // A binary file has no line counts.
    additions: Option<u32>,
    deletions: Option<u32>,
}

struct NumstatFile {
    path: String,
    old_path: Option<String>,
    additions: Option<u32>,
    deletions: Option<u32>,
}

fn parse_numstat(output: &[u8]) -> Vec<NumstatFile> {
    parse_numstat_fields(output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned()))
}

fn parse_numstat_fields(mut fields: impl Iterator<Item = String>) -> Vec<NumstatFile> {
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
        files.push(NumstatFile { path, old_path, additions, deletions });
    }
    files
}

fn parse_diff_stat(output: &[u8]) -> Vec<DiffStatFile> {
    let fields: Vec<_> = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    let mut files = Vec::new();
    let mut index = 0;
    while let Some(record) = fields.get(index).filter(|record| record.starts_with(b":")) {
        index += 1;
        let Some(status) = String::from_utf8_lossy(record).split_ascii_whitespace().last().and_then(|status| status.chars().next()).map(|status| status.to_string()) else {
            break;
        };
        let Some(first_path) = fields.get(index) else {
            break;
        };
        index += 1;
        let first_path = String::from_utf8_lossy(first_path).into_owned();
        let (old_path, path) = if matches!(status.as_str(), "R" | "C") {
            let Some(path) = fields.get(index) else { break };
            index += 1;
            (Some(first_path), String::from_utf8_lossy(path).into_owned())
        } else {
            (None, first_path)
        };
        files.push(DiffStatFile { path, old_path, status, additions: None, deletions: None });
    }
    files
        .into_iter()
        .zip(parse_numstat_fields(fields[index..].iter().map(|field| String::from_utf8_lossy(field).into_owned())))
        .map(|(file, stat)| DiffStatFile { additions: stat.additions, deletions: stat.deletions, ..file })
        .collect()
}

// A file git takes for text can still hold bytes that are not UTF-8, and one such file is no reason to
// lose the whole list; the stats read from a patch only need its line structure.
fn patch_output(path: &str, arguments: &[&str]) -> Result<String, String> {
    let output = git_result(path, arguments)?;
    if !output.status.success() {
        return Err(git_error_message(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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
    // The patch lists files in the same order as --raw after entries without a patch are removed.
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
            'U' => (Some(first_path.clone()), Some(first_path), "unmerged"),
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
    let patch = patch_output(path, &[&PATCH_ARGUMENTS[..], whitespace, &revisions].concat())?;
    let kept = ignore_whitespace.then(|| files_changed_beyond_whitespace(path, &revisions)).transpose()?;
    parse_changed_files(&raw, &patch, kept.as_ref())
}

// Untracked files are invisible to git diff, so they are listed separately and appended after the
// tracked changes, where they cannot disturb the index the patch stats are zipped by.
const UNTRACKED_FILE_READ_LIMIT: u64 = 32 * 1024 * 1024;

pub(crate) fn untracked_files(path: &str) -> Result<Vec<ChangedFile>, String> {
    let output = git_output_bytes(path, &["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"])
        .ok_or_else(|| "git ls-files failed.".to_string())?;
    let root = worktree_path(path)?;
    let mut files = Vec::new();
    for field in output.split(|byte| *byte == 0).filter(|field| !field.is_empty()) {
        let name = String::from_utf8(field.to_vec()).map_err(|error| error.to_string())?;
        let file = Path::new(&root).join(&name);
        let contents = fs::symlink_metadata(&file)
            .ok()
            .filter(|metadata| metadata.file_type().is_file() && metadata.len() <= UNTRACKED_FILE_READ_LIMIT)
            .and_then(|_| fs::read(file).ok());
        let is_binary = contents.as_ref().map_or(true, |contents| contents.contains(&0));
        let lines = contents.as_ref().map_or(0, |contents| {
            if is_binary || contents.is_empty() {
                0
            } else {
                let newlines = contents.iter().filter(|byte| **byte == b'\n').count() as u32;
                newlines + u32::from(contents.last() != Some(&b'\n'))
            }
        });
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
    let patch = patch_output(path, &[&PATCH_ARGUMENTS[..], whitespace, &revisions].concat())?;
    let kept = ignore_whitespace.then(|| files_changed_beyond_whitespace(path, &revisions)).transpose()?;
    let mut files = parse_changed_files(&raw, &patch, kept.as_ref())?;
    files.extend(untracked_files(path)?);
    Ok(files)
}

const STAGEABLE_ARGUMENTS: [&str; 1] = ["--diff-filter=u"];

fn excluded_pathspecs(paths: &[String]) -> Vec<String> {
    std::iter::once("--".to_string())
        .chain(paths.iter().map(|path| format!(":(exclude,literal){path}")))
        .collect()
}

pub(crate) fn conflicted_paths(path: &str) -> Result<Vec<String>, String> {
    let output = git_output_allow_empty(path, &["--no-optional-locks", "diff", "--name-only", "--diff-filter=U", "-z"])?;
    Ok(output.split('\0').filter(|path| !path.is_empty()).map(str::to_string).collect())
}

// What the index holds that HEAD does not. A repository without a commit yet has no HEAD, and git
// answers that by diffing the index against nothing, which is exactly what is staged.
pub(crate) fn staged_changed_files(path: &str, conflicted: &[String]) -> Result<Vec<ChangedFile>, String> {
    let pathspecs = excluded_pathspecs(conflicted);
    let pathspecs: Vec<_> = pathspecs.iter().map(String::as_str).collect();
    let raw = git_output_bytes(path, &[&["--no-optional-locks"][..], &RAW_ARGUMENTS[..], &STAGEABLE_ARGUMENTS[..], &["--cached"], &pathspecs].concat())
        .ok_or_else(|| "git diff failed.".to_string())?;
    let patch = patch_output(path, &[&["--no-optional-locks"][..], &PATCH_ARGUMENTS[..], &STAGEABLE_ARGUMENTS[..], &["--cached"], &pathspecs].concat())?;
    parse_changed_files(&raw, &patch, None)
}

// What the working tree holds that the index does not, with the files git has never been told about.
pub(crate) fn unstaged_changed_files(path: &str, conflicted: &[String]) -> Result<Vec<ChangedFile>, String> {
    let pathspecs = excluded_pathspecs(conflicted);
    let pathspecs: Vec<_> = pathspecs.iter().map(String::as_str).collect();
    let raw = git_output_bytes(path, &[&["--no-optional-locks"][..], &RAW_ARGUMENTS[..], &STAGEABLE_ARGUMENTS[..], &pathspecs].concat())
        .ok_or_else(|| "git diff failed.".to_string())?;
    let patch = patch_output(path, &[&["--no-optional-locks"][..], &PATCH_ARGUMENTS[..], &STAGEABLE_ARGUMENTS[..], &pathspecs].concat())?;
    let mut files = parse_changed_files(&raw, &patch, None)?;
    files.extend(untracked_files(path)?);
    Ok(files)
}

// git diff cannot see an untracked file, so an empty patch means falling back to an empty left side.
fn worktree_patch(repo_path: &str, base_sha: &str, path: &str, paths: &[&str], ignore_whitespace: bool) -> Result<String, String> {
    let whitespace = whitespace_arguments(ignore_whitespace);
    let base: &[&str] = if base_sha == INDEX_REF { &[] } else { std::slice::from_ref(&base_sha) };
    let patch = git_output_allow_empty(repo_path, &[&["--no-optional-locks"][..], &PATCH_ARGUMENTS[..], whitespace, base, &["--"], paths].concat())?;
    if !patch.is_empty() {
        return Ok(patch);
    }
    // --no-index reports a difference by exiting non-zero, so its status carries no error to report.
    let output = git_result(repo_path, &[&["--no-optional-locks"][..], &PATCH_ARGUMENTS[..], whitespace, &["--no-index", "--", "/dev/null", path]].concat())?;
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

// The index is addressed as `:path` and a commit as `sha:path`; the working tree is read from disk.
fn object_name(revision: &str, path: &str) -> String {
    if revision == INDEX_REF { format!(":{path}") } else { format!("{revision}:{path}") }
}

fn side_content(repo_path: &str, revision: &str, path: &str) -> Result<String, String> {
    if revision == WORKTREE_REF {
        let root = worktree_path(repo_path)?;
        return fs::read_to_string(Path::new(&root).join(path)).map_err(|error| error.to_string());
    }
    git_output_allow_empty(repo_path, &["show", &object_name(revision, path)])
}

fn side_binary_content(repo_path: &str, revision: &str, path: &str) -> Result<BinaryContent, String> {
    if revision == WORKTREE_REF {
        let root = worktree_path(repo_path)?;
        return worktree_binary_content(&root, path);
    }
    git_binary_content(repo_path, revision, path)
}

fn patch_for_path(patch: String, new_path: Option<&str>) -> String {
    let sections: Vec<_> = patch.split("\ndiff --git ").collect();
    if sections.len() <= 1 {
        return patch;
    }
    let Some(new_path) = new_path else {
        return patch;
    };
    sections
        .into_iter()
        .enumerate()
        .find(|(_, section)| {
            section.lines().any(|line| {
                line.strip_prefix("+++ b/") == Some(new_path)
                    || line.strip_prefix("rename to ") == Some(new_path)
                    || line.strip_prefix("copy to ") == Some(new_path)
            })
        })
        .map(|(index, section)| if index == 0 { section.to_string() } else { format!("diff --git {section}") })
        .unwrap_or(patch)
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
    let paths = match (old_path.as_deref(), new_path.as_deref()) {
        (Some(old_path), Some(new_path)) if old_path != new_path => vec![old_path, new_path],
        _ => vec![path.as_str()],
    };
    if head_sha == WORKTREE_REF {
        if let Some(new_worktree_path) = new_path.as_ref() {
            let root = worktree_path(repo_path)?;
            let metadata = fs::symlink_metadata(Path::new(&root).join(new_worktree_path)).map_err(|error| error.to_string())?;
            if !metadata.file_type().is_file() || metadata.len() > UNTRACKED_FILE_READ_LIMIT {
                let old_binary = old_path.as_ref().map(|path| side_binary_content(repo_path, base_sha, path)).transpose()?;
                return Ok(FileDiff {
                    old_binary,
                    new_binary: Some(worktree_binary_content(&root, new_worktree_path)?),
                    old_file_name: old_path,
                    new_file_name: new_path,
                    old_content: None,
                    new_content: None,
                    hunks: Vec::new(),
                    is_binary: true,
                });
            }
        }
    }
    let whitespace = whitespace_arguments(ignore_whitespace);
    let patch = if head_sha == WORKTREE_REF {
        worktree_patch(repo_path, base_sha, path, &paths, ignore_whitespace)?
    } else if head_sha == INDEX_REF {
        let base = (base_sha != "HEAD").then_some(base_sha);
        git_output_allow_empty(repo_path, &[&["--no-optional-locks"][..], &PATCH_ARGUMENTS[..], whitespace, &["--cached"], base.as_slice(), &["--"], &paths].concat())?
    } else {
        git_output_allow_empty(repo_path, &[&PATCH_ARGUMENTS[..], whitespace, &[base_sha, head_sha, "--"], &paths].concat())?
    };
    let patch = patch_for_path(patch, new_path.as_deref());
    // Content lines in a patch always carry a leading marker, so an unprefixed header is git's own.
    if patch.lines().any(|line| line.starts_with("Binary files ") || line == "GIT binary patch") {
        let old_binary = old_path.as_ref().map(|path| side_binary_content(repo_path, base_sha, path)).transpose()?;
        let new_binary = new_path.as_ref().map(|path| side_binary_content(repo_path, head_sha, path)).transpose()?;
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

    let old_content = old_path.as_ref().map(|path| side_content(repo_path, base_sha, path)).transpose()?;
    let new_content = new_path.as_ref().map(|path| side_content(repo_path, head_sha, path)).transpose()?;

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
    let object = object_name(sha, path);
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
    let head = crate::git::resolve_commit(&repo_path, &head)?;
    let base = resolve_diff_base(&repo_path, &base, &head)?;
    let revisions = [base.as_str(), head.as_str()];
    let output = git_output_bytes(&repo_path, &[&DIFF_STAT_ARGUMENTS[..], &revisions].concat())
        .ok_or_else(|| "git diff failed.".to_string())?;
    Ok(parse_diff_stat(&output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{EMPTY_TREE_REF, git_output, git_result};
    use std::{fs, path::Path};
    use crate::test_support::{remove_scratch_repository, scratch_repository};

    #[test]
    fn diffs_a_root_commit_against_the_empty_tree() {
        let (path, run) = scratch_repository("root-diff-stat");
        fs::write(Path::new(&path).join("root.txt"), "contents\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "root"]);

        let files = diff_stat(path.clone(), EMPTY_TREE_REF.to_string(), "HEAD".to_string()).unwrap();
        remove_scratch_repository(&path);

        assert_eq!(files.len(), 1);
        assert_eq!((files[0].path.as_str(), files[0].status.as_str()), ("root.txt", "A"));
    }

    #[test]
    fn diffs_a_real_root_of_a_shallow_repository_against_the_empty_tree() {
        let (path, run) = scratch_repository("shallow-root-diff-stat");
        fs::write(Path::new(&path).join("root.txt"), "root\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "root"]);
        fs::write(Path::new(&path).join("second.txt"), "second\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "second"]);

        let shallow_path = format!("{path}-shallow");
        let source = format!("file://{path}");
        let output = git_result(&path, &["clone", "--quiet", "--depth", "2", &source, &shallow_path]).unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let root = git_output(&shallow_path, &["rev-list", "--max-parents=0", "HEAD"]).unwrap();
        let files = diff_stat(shallow_path.clone(), EMPTY_TREE_REF.to_string(), root);
        remove_scratch_repository(&shallow_path);
        remove_scratch_repository(&path);

        let files = files.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].path.as_str(), files[0].status.as_str()), ("root.txt", "A"));
    }

    #[test]
    fn rejects_shallow_boundaries_against_the_empty_tree() {
        let (path, run) = scratch_repository("shallow-diff-stat");
        fs::write(Path::new(&path).join("first.txt"), "first\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "first"]);
        fs::write(Path::new(&path).join("second.txt"), "second\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "second"]);
        fs::write(Path::new(&path).join("third.txt"), "third\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "third"]);

        let source = format!("file://{path}");
        for depth in ["1", "2"] {
            let shallow_path = format!("{path}-shallow-{depth}");
            let output = git_result(&path, &["clone", "--quiet", "--depth", depth, &source, &shallow_path]).unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let short_sha = git_output(&shallow_path, &["rev-list", "--max-parents=0", "--abbrev-commit", "HEAD"]).unwrap();
            let result = diff_stat(shallow_path.clone(), EMPTY_TREE_REF.to_string(), "HEAD".to_string());
            remove_scratch_repository(&shallow_path);

            assert!(matches!(result, Err(message) if message == format!("{short_sha} is the edge of a shallow clone; its parent has not been fetched.")));
        }
        remove_scratch_repository(&path);
    }

    #[test]
    fn treats_large_untracked_files_as_binary_without_reading_them() {
        let (path, _run) = scratch_repository("diff-large-untracked");
        let file = fs::File::create(Path::new(&path).join("large.bin")).unwrap();
        file.set_len(UNTRACKED_FILE_READ_LIMIT + 1).unwrap();

        let files = untracked_files(&path).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].new_path.as_deref(), Some("large.bin"));
        assert!(files[0].is_binary);
        assert_eq!(files[0].additions, 0);

        let diff = file_diff(&path, INDEX_REF, WORKTREE_REF, None, Some("large.bin".to_string()), false).unwrap();
        assert!(diff.is_binary);
        assert_eq!(diff.new_binary.map(|content| content.size), Some(UNTRACKED_FILE_READ_LIMIT + 1));
        assert!(diff.hunks.is_empty());
        assert!(diff.old_content.is_none());
        assert!(diff.new_content.is_none());
        remove_scratch_repository(&path);
    }

    #[test]
    fn diffs_each_side_of_a_partially_staged_file_and_an_untracked_one() {
        let (path, run) = scratch_repository("diff-index-sides");
        fs::write(Path::new(&path).join("file.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "first"]);
        fs::write(Path::new(&path).join("file.txt"), "one\ntwo\n").unwrap();
        run(&["add", "file.txt"]);
        fs::write(Path::new(&path).join("file.txt"), "one\ntwo\nthree\n").unwrap();
        fs::write(Path::new(&path).join("new.txt"), "new\n").unwrap();
        let file = || (Some("file.txt".to_string()), Some("file.txt".to_string()));

        let staged = file_diff(&path, "HEAD", INDEX_REF, file().0, file().1, false).unwrap();
        assert_eq!(staged.old_content.as_deref(), Some("one\n"));
        assert_eq!(staged.new_content.as_deref(), Some("one\ntwo\n"));
        assert!(staged.hunks[0].contains("+two"));
        assert!(!staged.hunks[0].contains("three"));

        let unstaged = file_diff(&path, INDEX_REF, WORKTREE_REF, file().0, file().1, false).unwrap();
        assert_eq!(unstaged.old_content.as_deref(), Some("one\ntwo\n"));
        assert_eq!(unstaged.new_content.as_deref(), Some("one\ntwo\nthree\n"));
        assert!(unstaged.hunks[0].contains("+three"));
        assert!(!unstaged.hunks[0].contains("+two"));

        let untracked = file_diff(&path, INDEX_REF, WORKTREE_REF, None, Some("new.txt".to_string()), false).unwrap();
        assert_eq!(untracked.old_content, None);
        assert_eq!(untracked.new_content.as_deref(), Some("new\n"));
        assert!(untracked.hunks[0].contains("+new"));

        fs::write(Path::new(&path).join("blob.bin"), [0u8, 1, 2, 3]).unwrap();
        run(&["add", "blob.bin"]);
        let staged_binary = file_diff(&path, "HEAD", INDEX_REF, None, Some("blob.bin".to_string()), false).unwrap();
        assert!(staged_binary.is_binary);
        assert_eq!(staged_binary.new_binary.map(|content| content.size), Some(4));
        remove_scratch_repository(&path);
    }

    #[test]
    fn diffs_staged_files_before_the_first_commit() {
        let (path, run) = scratch_repository("diff-unborn-index");
        fs::write(Path::new(&path).join("first.txt"), "one\n").unwrap();
        run(&["add", "first.txt"]);

        let staged = file_diff(&path, "HEAD", INDEX_REF, None, Some("first.txt".to_string()), false).unwrap();

        assert_eq!(staged.old_content, None);
        assert_eq!(staged.new_content.as_deref(), Some("one\n"));
        assert!(staged.hunks[0].contains("+one"));
        remove_scratch_repository(&path);
    }

    #[test]
    fn diffs_both_sides_of_a_staged_rename() {
        let (path, run) = scratch_repository("diff-staged-rename");
        fs::write(Path::new(&path).join("a.txt"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
        run(&["add", "a.txt"]);
        run(&["commit", "--quiet", "--message", "first"]);
        run(&["mv", "a.txt", "b.txt"]);
        fs::write(Path::new(&path).join("b.txt"), "one\ntwo\nchanged\nfour\nfive\n").unwrap();
        run(&["add", "b.txt"]);

        let diff = file_diff(
            &path,
            "HEAD",
            INDEX_REF,
            Some("a.txt".to_string()),
            Some("b.txt".to_string()),
            false,
        )
        .unwrap();
        let patch = &diff.hunks[0];
        let additions = patch.lines().filter(|line| line.starts_with('+') && !line.starts_with("+++")).count();
        let deletions = patch.lines().filter(|line| line.starts_with('-') && !line.starts_with("---")).count();

        assert!(patch.contains("+changed"));
        assert_eq!(additions, 1);
        assert_eq!(deletions, 1);
        remove_scratch_repository(&path);
    }

    #[test]
    fn keeps_only_the_copy_destination_patch() {
        let (path, run) = scratch_repository("diff-staged-copy");
        fs::write(Path::new(&path).join("a.txt"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
        run(&["add", "a.txt"]);
        run(&["commit", "--quiet", "--message", "first"]);
        fs::copy(Path::new(&path).join("a.txt"), Path::new(&path).join("b.txt")).unwrap();
        fs::write(Path::new(&path).join("a.txt"), "one\ntwo\nchanged\nfour\nfive\n").unwrap();
        run(&["add", "-A"]);

        let diff = file_diff(
            &path,
            "HEAD",
            INDEX_REF,
            Some("a.txt".to_string()),
            Some("b.txt".to_string()),
            false,
        )
        .unwrap();
        let patch = &diff.hunks[0];

        let headers: Vec<_> = patch.lines().filter(|line| line.starts_with("diff --git ")).collect();
        assert_eq!(headers, ["diff --git a/a.txt b/b.txt"]);
        remove_scratch_repository(&path);
    }

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
    fn reads_counts_statuses_and_paths_from_combined_diff_output() {
        let files = parse_diff_stat(concat!(
            ":100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb M\0src/a.rs\0",
            ":000000 100644 0000000000000000000000000000000000000000 cccccccccccccccccccccccccccccccccccccccc A\0src/new.rs\0",
            ":100644 100644 dddddddddddddddddddddddddddddddddddddddd eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee R100\0old.txt\0new.txt\0",
            ":100644 100644 ffffffffffffffffffffffffffffffffffffffff 1111111111111111111111111111111111111111 M\0image.png\0",
            "3\t1\tsrc/a.rs\0",
            "4\t0\tsrc/new.rs\0",
            "0\t0\t\0old.txt\0new.txt\0",
            "-\t-\timage.png\0",
        ).as_bytes());

        assert_eq!(files.len(), 4);
        assert_eq!((files[0].path.as_str(), files[0].status.as_str(), files[0].additions, files[0].deletions), ("src/a.rs", "M", Some(3), Some(1)));
        assert_eq!((files[1].path.as_str(), files[1].status.as_str(), files[1].additions, files[1].deletions), ("src/new.rs", "A", Some(4), Some(0)));
        assert_eq!((files[2].old_path.as_deref(), files[2].path.as_str(), files[2].status.as_str()), (Some("old.txt"), "new.txt", "R"));
        assert_eq!((files[3].path.as_str(), files[3].status.as_str(), files[3].additions, files[3].deletions), ("image.png", "M", None, None));
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

    #[test]
    fn keeps_worktree_stats_aligned_across_a_conflicted_file() {
        let (path, run) = scratch_repository("worktree-conflict-stats");
        fs::write(Path::new(&path).join("a.txt"), "a base\n").unwrap();
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        fs::write(Path::new(&path).join("z.txt"), "z old\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["switch", "--quiet", "--create", "side"]);
        fs::write(Path::new(&path).join("file.txt"), "side\none\ntwo\nthree\n").unwrap();
        run(&["commit", "--quiet", "--all", "--message", "side"]);
        run(&["switch", "--quiet", "main"]);
        fs::write(Path::new(&path).join("file.txt"), "main\n").unwrap();
        run(&["commit", "--quiet", "--all", "--message", "main"]);
        let base = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        assert!(!git_result(&path, &["merge", "--no-commit", "side"]).unwrap().status.success());
        fs::write(Path::new(&path).join("a.txt"), "a base\na extra\n").unwrap();
        fs::write(Path::new(&path).join("z.txt"), "z new\n").unwrap();

        let files = worktree_changed_files(&path, &base, false).unwrap();

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].new_path.as_deref(), Some("a.txt"));
        assert_eq!((files[0].additions, files[0].deletions), (1, 0));
        assert_eq!(files[1].new_path.as_deref(), Some("file.txt"));
        assert_eq!((files[1].additions, files[1].deletions), (7, 0));
        assert_eq!(files[2].new_path.as_deref(), Some("z.txt"));
        assert_eq!((files[2].additions, files[2].deletions), (1, 1));
        remove_scratch_repository(&path);
    }
}
