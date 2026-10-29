//! What the window says when the disk lets Parrot down: in plain words and with the folder to look in, not in the
//! system's ("No space left on device (os error 28)").

use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The folder Parrot keeps everything in, once it has started: the one the messages point to.
static DATA: OnceLock<PathBuf> = OnceLock::new();

/// Point the messages at `data`, the data folder.
pub fn keep_in(data: &Path) {
    let _ = DATA.set(data.to_path_buf());
}

/// `error`, met in the data folder, as the window says it.
pub fn said(error: io::Error) -> String {
    said_about(&error, DATA.get().map(PathBuf::as_path))
}

/// A WAV file's error as the window says it: the disk's in plain words, anything else as hound says it.
pub fn wav_said(error: hound::Error) -> String {
    match error {
        hound::Error::IoError(error) => said(error),
        other => other.to_string(),
    }
}

/// `error`, met in `folder` (or in the data folder, when it isn't known), in plain words.
pub fn said_about(error: &io::Error, folder: Option<&Path>) -> String {
    let folder = folder.map(|folder| format!(" ({})", folder.display())).unwrap_or_default();
    match error.kind() {
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => "Parrot's disk is full: free up some space, then try again".into(),
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => {
            format!("Parrot can't write to its data folder{folder}: it may be read-only or locked; check it, then try again")
        }
        // a file where a folder should be, or the other way round: nothing Parrot does makes one
        ErrorKind::NotADirectory | ErrorKind::IsADirectory | ErrorKind::AlreadyExists | ErrorKind::DirectoryNotEmpty => {
            format!(
                "something in Parrot's data folder{folder} is not the way Parrot left it (a file where a folder should be, or the other way round); try again"
            )
        }
        _ => {
            // the system's words without its number: "Input/output error", not "Input/output error (os error 5)"
            let words = error.to_string();
            let number = error.raw_os_error().map(|code| format!(" (os error {code})")).unwrap_or_default();
            let words = words.strip_suffix(number.as_str()).unwrap_or(&words);
            format!("Parrot couldn't use its data folder{folder} ({words}); try again")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DATA: &str = "/Users/someone/Library/Application Support/io.github.qwertymuzaffar.parrot";

    fn said_of(kind: ErrorKind) -> String {
        said_about(&io::Error::from(kind), Some(Path::new(DATA)))
    }

    #[test]
    fn a_full_disk_is_said_so() {
        assert_eq!(said_of(ErrorKind::StorageFull), "Parrot's disk is full: free up some space, then try again");
        assert_eq!(said_of(ErrorKind::QuotaExceeded), said_of(ErrorKind::StorageFull));
    }

    #[test]
    fn a_folder_parrot_cant_write_to_is_named() {
        let said = said_of(ErrorKind::PermissionDenied);
        assert_eq!(said, format!("Parrot can't write to its data folder ({DATA}): it may be read-only or locked; check it, then try again"));
        assert_eq!(said_of(ErrorKind::ReadOnlyFilesystem), said);
        // before the data folder is known: no empty brackets
        assert!(said_about(&io::Error::from(ErrorKind::PermissionDenied), None).starts_with("Parrot can't write to its data folder: "));
    }

    #[test]
    fn a_file_where_a_folder_should_be_is_said_plainly() {
        for kind in [ErrorKind::NotADirectory, ErrorKind::IsADirectory, ErrorKind::AlreadyExists, ErrorKind::DirectoryNotEmpty] {
            let said = said_of(kind);
            assert!(said.starts_with(&format!("something in Parrot's data folder ({DATA}) is not the way Parrot left it")), "{kind:?}: {said}");
        }
    }

    #[test]
    fn anything_else_keeps_the_systems_words_without_its_number() {
        let error = io::Error::from_raw_os_error(5);
        let said = said_about(&error, Some(Path::new(DATA)));
        assert!(said.starts_with(&format!("Parrot couldn't use its data folder ({DATA}) (")) && said.ends_with("); try again"), "{said}");
        assert!(!said.contains("os error"), "{said}");
        assert_eq!(said_about(&io::Error::other("the cable came out"), None), "Parrot couldn't use its data folder (the cable came out); try again");
    }

    /// The numbers the system gives (macOS's and Linux's) are told apart as the kinds above.
    #[cfg(unix)]
    #[test]
    fn the_systems_own_errors_are_told_apart() {
        let said = |code| said_about(&io::Error::from_raw_os_error(code), Some(Path::new(DATA)));
        // ENOSPC, EROFS, EACCES, ENOTDIR, EISDIR, EEXIST
        assert_eq!(said(28), said_of(ErrorKind::StorageFull));
        assert_eq!(said(30), said_of(ErrorKind::PermissionDenied));
        assert_eq!(said(13), said_of(ErrorKind::PermissionDenied));
        for code in [20, 21, 17] {
            assert_eq!(said(code), said_of(ErrorKind::NotADirectory), "{code}");
        }
        // ENOTEMPTY: 66 on macOS, 39 on Linux; EDQUOT: 69 on macOS, 122 on Linux
        let (not_empty, quota) = if cfg!(target_os = "macos") { (66, 69) } else { (39, 122) };
        assert_eq!(said(not_empty), said_of(ErrorKind::DirectoryNotEmpty));
        assert_eq!(said(quota), said_of(ErrorKind::StorageFull));
    }

    #[test]
    fn a_wav_files_disk_error_is_said_plainly_too() {
        assert!(wav_said(hound::Error::IoError(io::Error::from(ErrorKind::StorageFull))).starts_with("Parrot's disk is full"));
        assert_eq!(wav_said(hound::Error::TooWide), hound::Error::TooWide.to_string());
    }
}
