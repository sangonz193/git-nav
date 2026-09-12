use serde::Serialize;
use crate::git::{git_output_allow_empty, resolve_commit};
use crate::graph::{graph_revisions, parse_commit};

const REFERENCE_FORMAT: &str = "%(refname)%00%(refname:short)%00%(objectname)%00%(*objectname)%00%(contents:subject)%00%(*contents:subject)%00%(creatordate:iso-strict)";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reference {
    kind: String,
    name: String,
    sha: String,
    subject: String,
    date: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedRevision {
    sha: String,
    subject: String,
}

fn picker_commits(repo_path: &str) -> Result<Vec<Vec<serde_json::Value>>, String> {
    let revisions = graph_revisions(repo_path);
    let arguments: Vec<&str> = ["log"]
        .into_iter()
        .chain(revisions.iter().map(String::as_str))
        .chain(["--topo-order", "--max-count=250", "--format=%H%x00%P%x00%an%x00%aI%x00%D%x00%s"])
        .collect();
    let output = git_output_allow_empty(repo_path, &arguments)?;
    let mut lanes = Vec::new();
    Ok(output
        .lines()
        .filter_map(|line| parse_commit(line, &mut lanes, &mut None))
        .collect())
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) fn reference_picker_commits(repo_path: String) -> Result<Vec<Vec<serde_json::Value>>, String> {
    picker_commits(&repo_path)
}

fn parse_references(output: &str) -> Vec<Reference> {
    output
        .lines()
        .filter_map(|line| {
            let [full_name, name, object, dereferenced, subject, tagged_subject, date] = line.split('\0').collect::<Vec<_>>()[..] else {
                return None;
            };
            let kind = if full_name.starts_with("refs/heads/") {
                "branch"
            } else if full_name.starts_with("refs/remotes/") {
                "remote"
            } else {
                "tag"
            };
            // A remote's HEAD only points at one of its branches, which is already listed on its own. Its
            // short name is the remote itself, so only the full name gives it away.
            if kind == "remote" && full_name.ends_with("/HEAD") {
                return None;
            }
            // An annotated tag names the tag object, and the commit it carries is behind the dereference.
            let (sha, subject) = if dereferenced.is_empty() {
                (object, subject)
            } else {
                (dereferenced, tagged_subject)
            };
            Some(Reference {
                kind: kind.to_string(),
                name: name.to_string(),
                sha: sha.to_string(),
                subject: subject.to_string(),
                date: date.to_string(),
            })
        })
        .collect()
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn repository_references(repo_path: String) -> Result<Vec<Reference>, String> {
    let output = git_output_allow_empty(
        &repo_path,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            &format!("--format={REFERENCE_FORMAT}"),
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    Ok(parse_references(&output))
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn resolve_revision(repo_path: String, revision: String) -> Result<ResolvedRevision, String> {
    let sha = resolve_commit(&repo_path, &revision)?;
    let subject = git_output_allow_empty(&repo_path, &["log", "-1", "--format=%s", &sha])?;
    Ok(ResolvedRevision { sha, subject: subject.trim().to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_annotated_tags_through_their_dereference_and_drops_remote_heads() {
        let references = parse_references(&[
            "refs/heads/main\0main\0branch-sha\0\0Ship it\0\02026-08-29T12:00:00+00:00",
            "refs/remotes/origin/HEAD\0origin\0branch-sha\0\0Ship it\0\02026-08-29T12:00:00+00:00",
            "refs/remotes/origin/main\0origin/main\0branch-sha\0\0Ship it\0\02026-08-29T12:00:00+00:00",
            "refs/tags/v1\0v1\0tag-sha\0commit-sha\0Tag message\0Tagged commit\02026-08-28T12:00:00+00:00",
        ]
        .join("\n"));

        let described: Vec<_> = references
            .iter()
            .map(|reference| (reference.kind.as_str(), reference.name.as_str(), reference.sha.as_str(), reference.subject.as_str()))
            .collect();
        assert_eq!(
            described,
            vec![
                ("branch", "main", "branch-sha", "Ship it"),
                ("remote", "origin/main", "branch-sha", "Ship it"),
                ("tag", "v1", "commit-sha", "Tagged commit"),
            ]
        );
    }
}
