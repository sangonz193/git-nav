use rusqlite::{Connection, params};
use serde::Serialize;
use std::{path::PathBuf, time::SystemTime, time::UNIX_EPOCH};
use crate::storage::data_dir;
use crate::git::{
    EMPTY_TREE_REF, WORKTREE_REF, git_output, git_result, primary_reference, project_id, resolve_commit,
    resolve_diff_base,
};
use crate::diff::{ChangedFile, changed_files, image_source, worktree_changed_files};
use crate::images::ImageSource;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Comparison {
    base_sha: String,
    head_sha: String,
    files: Vec<ChangedFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchSelection {
    base_ref: String,
    head_ref: String,
}

fn comparison(repo_path: &str, base_ref: &str, head_ref: &str, merge_base: bool, ignore_whitespace: bool) -> Result<Comparison, String> {
    let comparison = resolved_comparison(repo_path, base_ref, head_ref, merge_base, ignore_whitespace)?;
    crate::previews::warm(image_sources(repo_path, &comparison.base_sha, &comparison.head_sha, &comparison.files));
    Ok(comparison)
}

pub(crate) fn image_sources(repo_path: &str, base_sha: &str, head_sha: &str, files: &[ChangedFile]) -> Vec<ImageSource> {
    files
        .iter()
        .filter(|file| file.is_binary)
        .flat_map(|file| {
            [(base_sha, file.old_path.as_deref()), (head_sha, file.new_path.as_deref())]
                .into_iter()
                .filter_map(|(revision, path)| image_source(repo_path, revision, path?))
        })
        .collect()
}

fn resolved_comparison(repo_path: &str, base_ref: &str, head_ref: &str, merge_base: bool, ignore_whitespace: bool) -> Result<Comparison, String> {
    let is_worktree = head_ref == WORKTREE_REF;
    // The working tree has no commit of its own, so the checkout it sits on stands in for it as the
    // side the fork point is measured from.
    if is_worktree {
        let head_commit_sha = (merge_base || base_ref == EMPTY_TREE_REF)
            .then(|| resolve_commit(repo_path, "HEAD"))
            .transpose()?;
        let resolved_base_sha = resolve_diff_base(repo_path, base_ref, head_commit_sha.as_deref().unwrap_or_default())?;
        let base_sha = if merge_base && base_ref != EMPTY_TREE_REF {
            merge_base_for_commits(repo_path, &resolved_base_sha, head_commit_sha.as_deref().unwrap(), base_ref, "HEAD")?
        } else {
            resolved_base_sha
        };
        return Ok(Comparison {
            files: worktree_changed_files(repo_path, &base_sha, ignore_whitespace)?,
            base_sha,
            head_sha: WORKTREE_REF.to_string(),
        });
    }
    let head_commit_sha = resolve_commit(repo_path, head_ref)?;
    let resolved_base_sha = resolve_diff_base(repo_path, base_ref, &head_commit_sha)?;
    let base_sha = if merge_base && base_ref != EMPTY_TREE_REF {
        merge_base_for_commits(repo_path, &resolved_base_sha, &head_commit_sha, base_ref, head_ref)?
    } else {
        resolved_base_sha
    };
    Ok(Comparison {
        files: changed_files(repo_path, &base_sha, &head_commit_sha, ignore_whitespace)?,
        base_sha,
        head_sha: head_commit_sha,
    })
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn compare_refs(repo_path: String, base_ref: String, head_ref: String, merge_base: bool, ignore_whitespace: bool) -> Result<Comparison, String> {
    comparison(&repo_path, &base_ref, &head_ref, merge_base, ignore_whitespace)
}

const VIEWED_COMPARISON_LIMIT: i64 = 50;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewedFile {
    path: String,
    identity: String,
}

fn viewed_files_database_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("viewed-files.sqlite3"))
}

fn migrate_viewed_files_database(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)")
        .map_err(|error| error.to_string())?;
    let version = connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, Option<i64>>(0))
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    if version < 2 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "
                DROP TABLE IF EXISTS viewed_files;
                CREATE TABLE viewed_files (
                  project_id TEXT NOT NULL,
                  base_ref TEXT NOT NULL,
                  head_ref TEXT NOT NULL,
                  merge_base INTEGER NOT NULL,
                  path TEXT NOT NULL,
                  oid TEXT NOT NULL,
                  viewed_at INTEGER NOT NULL,
                  PRIMARY KEY (project_id, base_ref, head_ref, merge_base, path)
                );
                INSERT INTO schema_migrations (version) VALUES (2);
                ",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    if version < 3 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        // A mark now stands for the patch a file was read at, which both of its blobs decide together, so
        // the marks stored against one of them no longer say what they were taken to say.
        transaction
            .execute_batch(
                "
                ALTER TABLE viewed_files RENAME COLUMN oid TO identity;
                DELETE FROM viewed_files;
                INSERT INTO schema_migrations (version) VALUES (3);
                ",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn viewed_files_database(path: PathBuf) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    migrate_viewed_files_database(&mut connection)?;
    Ok(connection)
}

fn read_viewed_files(
    connection: &Connection,
    project: &str,
    base_ref: &str,
    head_ref: &str,
    merge_base: bool,
) -> Result<Vec<ViewedFile>, String> {
    let mut statement = connection
        .prepare("SELECT path, identity FROM viewed_files WHERE project_id = ?1 AND base_ref = ?2 AND head_ref = ?3 AND merge_base = ?4")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project, base_ref, head_ref, merge_base], |row| {
            Ok(ViewedFile {
                path: row.get(0)?,
                identity: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

// Marks are only worth keeping for the comparisons still being read, so the least recently marked ones
// fall away rather than growing a store nothing empties.
fn prune_viewed_comparisons(connection: &Connection, project: &str) -> Result<(), String> {
    connection
        .execute(
            "
            DELETE FROM viewed_files WHERE project_id = ?1 AND (base_ref, head_ref, merge_base) NOT IN (
              SELECT base_ref, head_ref, merge_base FROM viewed_files
              WHERE project_id = ?1
              GROUP BY base_ref, head_ref, merge_base
              ORDER BY MAX(viewed_at) DESC
              LIMIT ?2
            )
            ",
            params![project, VIEWED_COMPARISON_LIMIT],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn write_viewed_file(
    connection: &Connection,
    project: &str,
    base_ref: &str,
    head_ref: &str,
    merge_base: bool,
    path: &str,
    identity: &str,
    viewed: bool,
) -> Result<(), String> {
    if !viewed {
        connection
            .execute(
                "DELETE FROM viewed_files WHERE project_id = ?1 AND base_ref = ?2 AND head_ref = ?3 AND merge_base = ?4 AND path = ?5",
                params![project, base_ref, head_ref, merge_base, path],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    let viewed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs() as i64;
    connection
        .execute(
            "
            INSERT INTO viewed_files (project_id, base_ref, head_ref, merge_base, path, identity, viewed_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT (project_id, base_ref, head_ref, merge_base, path)
            DO UPDATE SET identity = excluded.identity, viewed_at = excluded.viewed_at
            ",
            params![project, base_ref, head_ref, merge_base, path, identity, viewed_at],
        )
        .map_err(|error| error.to_string())?;
    prune_viewed_comparisons(connection, project)
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn viewed_files(repo_path: String, base_ref: String, head_ref: String, merge_base: bool) -> Result<Vec<ViewedFile>, String> {
    let project = project_id(&repo_path)?;
    let connection = viewed_files_database(viewed_files_database_path()?)?;
    read_viewed_files(&connection, &project, &base_ref, &head_ref, merge_base)
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn set_file_viewed(
    repo_path: String,
    base_ref: String,
    head_ref: String,
    merge_base: bool,
    path: String,
    identity: String,
    viewed: bool,
) -> Result<(), String> {
    let project = project_id(&repo_path)?;
    let connection = viewed_files_database(viewed_files_database_path()?)?;
    write_viewed_file(&connection, &project, &base_ref, &head_ref, merge_base, &path, &identity, viewed)
}

fn merge_base_sha(repo_path: &str, base_ref: &str, head_ref: &str) -> Result<String, String> {
    let base_sha = resolve_commit(repo_path, base_ref)?;
    let head_sha = resolve_commit(repo_path, head_ref)?;
    merge_base_for_commits(repo_path, &base_sha, &head_sha, base_ref, head_ref)
}

fn merge_base_for_commits(repo_path: &str, base_sha: &str, head_sha: &str, base_ref: &str, head_ref: &str) -> Result<String, String> {
    let output = git_result(repo_path, &["merge-base", base_sha, head_sha])?;
    let sha = String::from_utf8(output.stdout).map_err(|error| error.to_string())?.trim().to_string();
    if !output.status.success() {
        if output.status.code() == Some(1) && sha.is_empty() {
            return Err(format!("Could not find a merge base for {base_ref} and {head_ref}."));
        }
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    if sha.is_empty() {
        return Err(format!("Could not find a merge base for {base_ref} and {head_ref}."));
    }
    Ok(sha)
}

// The range is named by its two refs rather than by where they point now, so the comparison follows
// the branch as it moves instead of freezing at the moment it was opened.
fn branch_range(repo_path: &str, reference: &str) -> Result<BranchSelection, String> {
    let primary = primary_reference(repo_path)?;
    merge_base_sha(repo_path, &primary, reference)?;
    Ok(BranchSelection { base_ref: primary, head_ref: reference.to_string() })
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) fn select_branch_range(repo_path: String, reference: String) -> Result<BranchSelection, String> {
    branch_range(&repo_path, &reference)
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn merge_base(repo_path: String, left: String, right: String) -> Result<String, String> {
    let left = resolve_commit(&repo_path, &left)?;
    let right = resolve_commit(&repo_path, &right)?;
    git_output(&repo_path, &["merge-base", &left, &right])
        .ok_or_else(|| "These refs share no common history.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs, path::Path};
    use crate::diff::diff_file;
    use crate::images::{IMAGE_PREVIEW_LIMIT, response};
    use crate::test_support::{remove_scratch_repository, scratch_repository};

    #[test]
    fn keeps_a_viewed_mark_against_the_blob_it_was_made_at() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_viewed_files_database(&mut connection).unwrap();

        write_viewed_file(&connection, "project", "main", "feature", false, "src/main.rs", "abc", true).unwrap();
        write_viewed_file(&connection, "project", "main", "other", false, "src/main.rs", "def", true).unwrap();

        let marks = read_viewed_files(&connection, "project", "main", "feature", false).unwrap();
        assert_eq!(marks.len(), 1);
        assert_eq!(marks[0].path, "src/main.rs");
        assert_eq!(marks[0].identity, "abc");

        write_viewed_file(&connection, "project", "main", "feature", false, "src/main.rs", "abc", false).unwrap();
        assert!(read_viewed_files(&connection, "project", "main", "feature", false).unwrap().is_empty());
    }

    // Both ranges end at the same commit, so a file reads as the same blob in each one and only the
    // range they were made in tells the marks apart.
    #[test]
    fn keeps_a_viewed_mark_within_the_range_it_was_made_in() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_viewed_files_database(&mut connection).unwrap();

        write_viewed_file(&connection, "project", "main", "feature", false, "src/main.rs", "abc", true).unwrap();

        assert!(read_viewed_files(&connection, "project", "main", "feature", true).unwrap().is_empty());
        let direct = read_viewed_files(&connection, "project", "main", "feature", false).unwrap();
        assert_eq!(direct.len(), 1);
        assert_eq!(direct[0].identity, "abc");

        write_viewed_file(&connection, "project", "main", "feature", true, "src/main.rs", "abc", true).unwrap();
        write_viewed_file(&connection, "project", "main", "feature", true, "src/main.rs", "abc", false).unwrap();
        assert_eq!(read_viewed_files(&connection, "project", "main", "feature", false).unwrap().len(), 1);
    }

    #[test]
    fn retires_marks_taken_against_a_single_blob() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
                CREATE TABLE viewed_files (
                  project_id TEXT NOT NULL,
                  base_ref TEXT NOT NULL,
                  head_ref TEXT NOT NULL,
                  merge_base INTEGER NOT NULL,
                  path TEXT NOT NULL,
                  oid TEXT NOT NULL,
                  viewed_at INTEGER NOT NULL,
                  PRIMARY KEY (project_id, base_ref, head_ref, merge_base, path)
                );
                INSERT INTO schema_migrations (version) VALUES (2);
                INSERT INTO viewed_files VALUES ('project', 'main', 'feature', 0, 'src/main.rs', 'abc', 1);
                ",
            )
            .unwrap();

        migrate_viewed_files_database(&mut connection).unwrap();

        assert!(read_viewed_files(&connection, "project", "main", "feature", false).unwrap().is_empty());
        write_viewed_file(&connection, "project", "main", "feature", false, "src/main.rs", "abc:def", true).unwrap();
        let marks = read_viewed_files(&connection, "project", "main", "feature", false).unwrap();
        assert_eq!(marks[0].identity, "abc:def");
    }

    #[test]
    fn keeps_recent_viewed_comparisons_per_project() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_viewed_files_database(&mut connection).unwrap();
        for index in 0..VIEWED_COMPARISON_LIMIT + 5 {
            connection
                .execute(
                    "INSERT INTO viewed_files (project_id, base_ref, head_ref, merge_base, path, identity, viewed_at) VALUES ('project', 'main', ?1, 0, 'src/main.rs', 'abc', ?2)",
                    params![index.to_string(), index],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO viewed_files (project_id, base_ref, head_ref, merge_base, path, identity, viewed_at) VALUES ('other-project', 'main', 'old', 0, 'src/main.rs', 'abc', 0)",
                [],
            )
            .unwrap();

        prune_viewed_comparisons(&connection, "project").unwrap();

        let comparisons = connection
            .query_row(
                "SELECT COUNT(DISTINCT head_ref) FROM viewed_files WHERE project_id = 'project'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(comparisons, VIEWED_COMPARISON_LIMIT);
        let oldest = connection
            .query_row(
                "SELECT MIN(viewed_at) FROM viewed_files WHERE project_id = 'project'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(oldest, 5);
        let other_project = connection
            .query_row(
                "SELECT COUNT(*) FROM viewed_files WHERE project_id = 'other-project'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(other_project, 1);
    }

    #[test]
    fn compares_a_branch_against_where_it_forked_from_the_primary_branch() {
        let (path, run) = scratch_repository("branch-range");
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

        run(&["checkout", "--quiet", "-b", "feature"]);
        write("feature.txt", "one\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "feature"]);
        run(&["checkout", "--quiet", "main"]);
        write("primary.txt", "later\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "primary"]);
        run(&["update-ref", "refs/remotes/origin/main", "HEAD"]);

        let selection = branch_range(&path, "feature").unwrap();
        let names = |comparison: &Comparison| {
            let mut names: Vec<_> = comparison.files.iter().filter_map(|file| file.new_path.clone().or(file.old_path.clone())).collect();
            names.sort();
            names
        };
        let forked = comparison(&path, &selection.base_ref, &selection.head_ref, true, false).unwrap();
        let direct = comparison(&path, &selection.base_ref, &selection.head_ref, false, false).unwrap();

        run(&["checkout", "--quiet", "feature"]);
        write("second.txt", "two\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "second"]);
        let after_commit = comparison(&path, &selection.base_ref, &selection.head_ref, true, false).unwrap();
        remove_scratch_repository(&path);

        assert_eq!((selection.base_ref.as_str(), selection.head_ref.as_str()), ("origin/main", "feature"));
        assert_eq!(names(&forked), ["feature.txt"]);
        // Without the fork point the primary branch's own commit reads as a deletion on the branch.
        assert_eq!(names(&direct), ["feature.txt", "primary.txt"]);
        assert_eq!(names(&after_commit), ["feature.txt", "second.txt"]);
    }

    #[test]
    fn compares_a_root_commit_against_the_empty_tree() {
        let (path, run) = scratch_repository("root-comparison");
        fs::write(Path::new(&path).join("root.txt"), "contents\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "root"]);

        let comparison = comparison(&path, EMPTY_TREE_REF, "HEAD", true, false).unwrap();
        remove_scratch_repository(&path);

        assert_eq!(comparison.files.len(), 1);
        assert_eq!(comparison.files[0].new_path.as_deref(), Some("root.txt"));
    }

    #[test]
    fn directly_compares_an_unborn_worktree_against_a_commit() {
        let (path, run) = scratch_repository("unborn-worktree-comparison");
        fs::write(Path::new(&path).join("main.txt"), "main\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "main"]);
        run(&["checkout", "--quiet", "--orphan", "unborn"]);

        let comparison = comparison(&path, "main", WORKTREE_REF, false, false).unwrap();
        remove_scratch_repository(&path);

        assert_eq!(comparison.head_sha, WORKTREE_REF);
    }

    #[test]
    fn leaves_out_a_file_whose_only_changes_are_whitespace() {
        let (path, run) = scratch_repository("ignore-whitespace");
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        write("spaced.txt", "one\ntwo\n");
        write("changed.txt", "one\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "feature"]);
        write("spaced.txt", "one  \n\ttwo\n");
        write("changed.txt", "two\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "feature"]);

        let names = |comparison: Comparison| {
            let mut names: Vec<_> = comparison.files.iter().filter_map(|file| file.new_path.clone()).collect();
            names.sort();
            names
        };
        let all = names(comparison(&path, "main", "feature", false, false).unwrap());
        let ignored = names(comparison(&path, "main", "feature", false, true).unwrap());
        remove_scratch_repository(&path);

        assert_eq!(all, ["changed.txt", "spaced.txt"]);
        assert_eq!(ignored, ["changed.txt"]);
    }

    #[test]
    fn keeps_files_after_a_rename_when_ignoring_whitespace() {
        let (path, run) = scratch_repository("ignore-whitespace-rename");
        let write =
            |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        write("old.txt", "unchanged\n");
        write("later.txt", "before\nkeep\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "feature"]);
        run(&["mv", "old.txt", "renamed.txt"]);
        write("later.txt", "after\nnext\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "rename and change"]);

        let comparison = comparison(&path, "main", "feature", false, true).unwrap();
        remove_scratch_repository(&path);

        let later = comparison
            .files
            .iter()
            .find(|file| file.new_path.as_deref() == Some("later.txt"))
            .unwrap();
        assert_eq!(later.additions, 2);
        assert_eq!(later.deletions, 2);
        assert!(comparison
            .files
            .iter()
            .any(|file| file.new_path.as_deref() == Some("renamed.txt")));
    }

    #[test]
    fn reports_when_refs_have_no_merge_base() {
        let (path, run) = scratch_repository("no-merge-base");
        fs::write(Path::new(&path).join("main.txt"), "main\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "main"]);
        run(&["checkout", "--quiet", "--orphan", "unrelated"]);
        fs::write(Path::new(&path).join("unrelated.txt"), "unrelated\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "unrelated"]);

        let result = comparison(&path, "main", "unrelated", true, false);
        remove_scratch_repository(&path);

        assert!(matches!(result, Err(message) if message == "Could not find a merge base for main and unrelated."));
    }

    #[test]
    fn diffs_the_working_tree_including_untracked_files() {
        let path = env::temp_dir()
            .join(format!("git-nav-worktree-diff-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        write("kept.txt", "one\ntwo\nthree\n");
        write("removed.txt", "gone\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        write("kept.txt", "one\nchanged\nthree\n");
        fs::remove_file(Path::new(&path).join("removed.txt")).unwrap();
        write("untracked.txt", "fresh\n\nlines\n");
        fs::write(Path::new(&path).join(".gitignore"), "ignored.txt\n").unwrap();
        write("ignored.txt", "invisible\n");

        let comparison = compare_refs(path.clone(), "HEAD".to_string(), WORKTREE_REF.to_string(), false, false).unwrap();
        let untracked = diff_file(path.clone(), comparison.base_sha.clone(), comparison.head_sha.clone(), None, Some("untracked.txt".to_string()), false);
        let modified = diff_file(path.clone(), comparison.base_sha.clone(), comparison.head_sha.clone(), Some("kept.txt".to_string()), Some("kept.txt".to_string()), false);
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(comparison.head_sha, WORKTREE_REF);
        let names: Vec<_> = comparison.files.iter().map(|file| (file.status.as_str(), file.new_path.as_deref(), file.old_path.as_deref())).collect();
        assert!(names.contains(&("modified", Some("kept.txt"), Some("kept.txt"))), "{names:?}");
        assert!(names.contains(&("deleted", None, Some("removed.txt"))), "{names:?}");
        // .gitignore is untracked too, but the ignored file it names must not be listed.
        assert!(names.contains(&("added", Some("untracked.txt"), None)), "{names:?}");
        assert!(!names.iter().any(|(_, new, _)| *new == Some("ignored.txt")), "{names:?}");

        let untracked_stat = comparison.files.iter().find(|file| file.new_path.as_deref() == Some("untracked.txt")).unwrap();
        assert_eq!((untracked_stat.additions, untracked_stat.deletions), (3, 0));

        let untracked = untracked.unwrap();
        assert!(untracked.hunks[0].contains("+fresh"), "{:?}", untracked.hunks);
        assert_eq!(untracked.new_content.as_deref(), Some("fresh\n\nlines\n"));
        assert_eq!(untracked.old_content, None);

        let modified = modified.unwrap();
        assert!(modified.hunks[0].contains("+one\nchanged") || modified.hunks[0].contains("+changed"), "{:?}", modified.hunks);
        assert_eq!(modified.new_content.as_deref(), Some("one\nchanged\nthree\n"));
        assert_eq!(modified.old_content.as_deref(), Some("one\ntwo\nthree\n"));
    }

    #[test]
    fn previews_binary_images_on_both_sides() {
        let (path, run) = scratch_repository("binary-diff");
        let write = |name: &str, contents: &[u8]| fs::write(Path::new(&path).join(name), contents).unwrap();
        write("shot.png", b"\x89PNG\0old");
        write("blob.bin", b"\0old");
        write("large.png", b"\x89PNG\0old");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        write("shot.png", b"\x89PNG\0new!");
        write("blob.bin", b"\0new!");
        write("fresh.png", b"\x89PNG\0fresh");

        let comparison = compare_refs(path.clone(), "HEAD".to_string(), WORKTREE_REF.to_string(), false, false).unwrap();
        let (base, head) = (comparison.base_sha.clone(), comparison.head_sha.clone());
        let image = diff_file(path.clone(), base.clone(), head.clone(), Some("shot.png".to_string()), Some("shot.png".to_string()), false).unwrap();
        let other = diff_file(path.clone(), base.clone(), head.clone(), Some("blob.bin".to_string()), Some("blob.bin".to_string()), false).unwrap();
        let untracked = diff_file(path.clone(), base, head, None, Some("fresh.png".to_string()), false).unwrap();
        let served = |content: &Option<crate::diff::BinaryContent>| {
            content.as_ref().and_then(|content| content.image_token.as_deref()).map(|token| response(token).into_body())
        };
        let old_bytes = served(&image.old_binary);
        let new_bytes = served(&image.new_binary);
        let untracked_bytes = served(&untracked.new_binary);
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "modified"]);
        let mut large = vec![0; IMAGE_PREVIEW_LIMIT + 1];
        large[..5].copy_from_slice(b"\x89PNG\0");
        write("large.png", &large);
        run(&["add", "large.png"]);
        run(&["commit", "--quiet", "--message", "large image"]);
        let committed = compare_refs(path.clone(), "HEAD~2".to_string(), "HEAD~1".to_string(), false, false).unwrap();
        let committed_image = diff_file(path.clone(), committed.base_sha, committed.head_sha, Some("shot.png".to_string()), Some("shot.png".to_string()), false).unwrap();
        let large_comparison = compare_refs(path.clone(), "HEAD~1".to_string(), "HEAD".to_string(), false, false).unwrap();
        let large_image = diff_file(path.clone(), large_comparison.base_sha, large_comparison.head_sha, Some("large.png".to_string()), Some("large.png".to_string()), false).unwrap();
        #[cfg(unix)]
        let outside = format!("{path}-outside.png");
        #[cfg(unix)]
        {
            fs::write(&outside, b"\x89PNG\0outside").unwrap();
            fs::remove_file(Path::new(&path).join("shot.png")).unwrap();
            std::os::unix::fs::symlink(&outside, Path::new(&path).join("shot.png")).unwrap();
        }
        #[cfg(unix)]
        let symlinked_comparison = compare_refs(path.clone(), "HEAD".to_string(), WORKTREE_REF.to_string(), false, false).unwrap();
        #[cfg(unix)]
        let symlinked_image = diff_file(path.clone(), symlinked_comparison.base_sha, symlinked_comparison.head_sha, Some("shot.png".to_string()), Some("shot.png".to_string()), false).unwrap();
        remove_scratch_repository(&path);
        #[cfg(unix)]
        fs::remove_file(&outside).unwrap();

        assert!(image.is_binary);
        let old = image.old_binary.unwrap();
        let new = image.new_binary.unwrap();
        assert_eq!((old.size, new.size), (8, 9));
        assert_eq!(old_bytes.as_deref(), Some(&b"\x89PNG\0old"[..]));
        assert_eq!(new_bytes.as_deref(), Some(&b"\x89PNG\0new!"[..]));

        assert!(other.is_binary);
        assert_eq!(other.old_binary.as_ref().map(|content| (content.size, content.image_token.is_none())), Some((4, true)));
        assert_eq!(other.new_binary.as_ref().map(|content| (content.size, content.image_token.is_none())), Some((5, true)));

        assert!(untracked.is_binary);
        assert!(untracked.old_binary.is_none());
        assert_eq!(untracked_bytes.as_deref(), Some(&b"\x89PNG\0fresh"[..]));

        assert!(committed_image.old_binary.unwrap().image_token.is_some());
        assert!(committed_image.new_binary.unwrap().image_token.is_some());

        let large = large_image.new_binary.unwrap();
        assert_eq!(large.size, (IMAGE_PREVIEW_LIMIT + 1) as u64);
        assert!(large.image_token.is_none());

        #[cfg(unix)]
        {
            let symlinked = symlinked_image.new_binary.unwrap();
            assert_eq!(symlinked.size, outside.len() as u64);
            assert!(symlinked.image_token.is_none());
        }
    }
}
