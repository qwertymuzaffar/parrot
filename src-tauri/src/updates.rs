//! "Check for updates" in Settings: asks GitHub for the latest release, only when the user clicks it. Asked from here
//! rather than from the webview, so the webview's Content-Security-Policy keeps it off every outside host.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const LATEST: &str = "https://api.github.com/repos/qwertymuzaffar/parrot/releases/latest";
/// Where a release's own page is; anything else GitHub might answer is not followed.
const RELEASES: &str = "https://github.com/qwertymuzaffar/parrot/releases/";

/// The pages the app may open in the system browser: the project's GitHub pages and its website.
const OPENABLE: [&str; 2] = ["https://github.com/qwertymuzaffar/parrot/", "https://qwertymuzaffar.github.io/parrot/"];

#[derive(Serialize, Debug, PartialEq)]
pub struct Release {
    /// "0.3.0" (the tag without its leading v)
    pub version: String,
    /// the release's page, with its notes and installers
    pub url: String,
}

pub async fn latest() -> Result<Release, String> {
    let client = reqwest::Client::builder().user_agent("Parrot").timeout(Duration::from_secs(15)).build().map_err(|error| error.to_string())?;
    let response = client
        .get(LATEST)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "Couldn't reach GitHub. Are you online?".to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub didn't say ({}). Try again later.", response.status()));
    }
    let body = response.bytes().await.map_err(|_| "Couldn't reach GitHub. Are you online?".to_string())?;
    release(&body)
}

/// The version and page of a release, from GitHub's answer.
fn release(body: &[u8]) -> Result<Release, String> {
    let answer: Value = serde_json::from_slice(body).map_err(|_| "GitHub's answer made no sense. Try again later.".to_string())?;
    let tag = answer["tag_name"].as_str().ok_or("GitHub's answer has no version. Try again later.")?;
    let url = answer["html_url"]
        .as_str()
        .filter(|url| url.starts_with(RELEASES) && openable(url))
        .unwrap_or("https://github.com/qwertymuzaffar/parrot/releases/latest");
    Ok(Release { version: tag.trim().trim_start_matches('v').to_string(), url: url.to_string() })
}

/// Only the project's own pages, written plainly: no "..", and no character a system opener might read as more than
/// part of the address.
fn openable(url: &str) -> bool {
    OPENABLE.iter().any(|page| url.starts_with(page))
        && !url.contains("..")
        && url.chars().all(|character| character.is_ascii_alphanumeric() || "-._~/:#".contains(character))
}

/// Open one of the project's pages in the system browser (a link in the webview would open inside the app).
pub fn open(url: &str) -> Result<(), String> {
    if !openable(url) {
        return Err("Parrot opens only its own pages".into());
    }
    #[cfg(target_os = "macos")]
    let mut opener = std::process::Command::new("open");
    // rundll32 rather than `cmd /C start`, so no shell reads the address
    #[cfg(target_os = "windows")]
    let mut opener = {
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut opener = std::process::Command::new("xdg-open");
    opener.arg(url).spawn().map(|_| ()).map_err(|error| format!("Couldn't open the browser: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_and_page_of_a_release() {
        let body = br#"{"tag_name": "v0.3.0", "html_url": "https://github.com/qwertymuzaffar/parrot/releases/tag/v0.3.0", "assets": []}"#;
        assert_eq!(
            release(body).unwrap(),
            Release { version: "0.3.0".into(), url: "https://github.com/qwertymuzaffar/parrot/releases/tag/v0.3.0".into() }
        );
    }

    #[test]
    fn falls_back_to_the_latest_release_page_for_any_other_page() {
        let body = br#"{"tag_name": "0.3.0", "html_url": "https://example.com/parrot"}"#;
        assert_eq!(release(body).unwrap().url, "https://github.com/qwertymuzaffar/parrot/releases/latest");
        assert_eq!(release(body).unwrap().version, "0.3.0");
    }

    #[test]
    fn says_so_when_the_answer_is_not_a_release() {
        assert!(release(br#"{"message": "Not Found"}"#).is_err());
        assert!(release(b"<html>").is_err());
    }

    /// Asks GitHub for real: cargo test --lib -- --ignored asks_github
    #[test]
    #[ignore]
    fn asks_github() {
        let latest = tauri::async_runtime::block_on(latest()).unwrap();
        println!("{latest:?}");
        assert!(latest.url.starts_with(RELEASES));
    }

    #[test]
    fn opens_only_the_projects_own_pages() {
        assert!(openable("https://github.com/qwertymuzaffar/parrot/releases/tag/v0.3.0"));
        assert!(openable("https://qwertymuzaffar.github.io/parrot/#download"));
        for url in [
            "https://github.com/qwertymuzaffar/parrot-fork/releases",
            "https://github.com/qwertymuzaffar/parrot/../../someone/else",
            "https://github.com/qwertymuzaffar/parrot/releases\" & calc",
            "http://github.com/qwertymuzaffar/parrot/",
            "https://github.com.evil.example/qwertymuzaffar/parrot/",
            "file:///etc/passwd",
            "https://example.com/",
        ] {
            assert!(!openable(url), "{url}");
            assert!(open(url).is_err(), "{url}");
        }
    }
}
