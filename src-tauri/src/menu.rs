//! The app menu, as a program has one: File › New text, Parrot › Settings…, Edit › Find, a Practice menu that lists
//! the keys the practice screen answers to, Window › Home. An item chosen is told to the window as the `menu` event,
//! with the item's id (the window acts on it: src/app/core/menu.ts). The window says which screen it shows
//! (`set_screen`), and an item that acts on one screen is enabled on it alone.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

/// An item of Parrot's own, and the screens it acts on.
struct Item {
    item: MenuItem<Wry>,
    screens: &'static [&'static str],
}

/// Parrot's own items, kept to enable them for the screen shown.
pub struct Items(Vec<Item>);

const HOME_AND_PRACTICE: &[&str] = &["home", "practice"];
const PRACTICE: &[&str] = &["practice"];
const EVERYWHERE: &[&str] = &["waiting", "setup", "preview", "home", "practice"];

/// Builds the menu, hangs it on the app and sends what is chosen to the window.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let mut items = Vec::new();
    // an item of Parrot's own, enabled as the first screen (the wait for the engine) has it; set_screen takes over
    let mut own = |id: &str, text: &str, keys: Option<&str>, screens: &'static [&'static str]| -> tauri::Result<MenuItem<Wry>> {
        let item = MenuItem::with_id(app, id, text, screens.contains(&"waiting"), keys)?;
        items.push(Item { item: item.clone(), screens });
        Ok(item)
    };
    let new_text = own("new", "New text", Some("CmdOrCtrl+N"), HOME_AND_PRACTICE)?;
    let settings = own("settings", "Settings…", Some("CmdOrCtrl+,"), EVERYWHERE)?;
    let find = own("find", "Find", Some("CmdOrCtrl+F"), HOME_AND_PRACTICE)?;
    let home = own("home", "Home", None, HOME_AND_PRACTICE)?;
    // the keys the practice screen answers to, named so they can be found. The screen keeps the keys (practice.ts);
    // the menu only names them: a bare key on a menu item would take that letter from every field
    let listen = own("listen", "Listen (Space)", None, PRACTICE)?;
    let record = own("record", "Record (R)", None, PRACTICE)?;
    let mine = own("mine", "Mine (M)", None, PRACTICE)?;
    let previous = own("previous", "Previous part (↑)", None, PRACTICE)?;
    let next = own("next", "Next part (↓)", None, PRACTICE)?;
    let stop = own("stop", "Stop (Esc)", None, PRACTICE)?;

    let sep = || PredefinedMenuItem::separator(app);

    // the Mac's first menu is the program's; elsewhere its items are File's
    #[cfg(target_os = "macos")]
    let parrot = Submenu::with_items(
        app,
        "Parrot",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Parrot"), None)?,
            &sep()?,
            &settings,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    #[cfg(target_os = "macos")]
    let file = Submenu::with_items(app, "File", true, &[&new_text])?;
    #[cfg(not(target_os = "macos"))]
    let file = {
        let about = tauri::menu::AboutMetadataBuilder::new().name(Some("Parrot")).version(Some(app.package_info().version.to_string())).build();
        Submenu::with_items(
            app,
            "File",
            true,
            &[
                &new_text,
                &sep()?,
                &settings,
                &sep()?,
                &PredefinedMenuItem::about(app, Some("About Parrot"), Some(about))?,
                &sep()?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?
    };
    // the system's Edit menu is what gives the fields their ⌘Z, ⌘X, ⌘C, ⌘V and ⌘A: it stays whole
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &sep()?,
            &find,
        ],
    )?;
    #[cfg(target_os = "macos")]
    let view = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
    let practice = Submenu::with_items(app, "Practice", true, &[&listen, &record, &mine, &sep()?, &previous, &next, &sep()?, &stop])?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?, &sep()?, &home],
    )?;
    #[cfg(target_os = "macos")]
    window.set_as_windows_menu_for_nsapp()?;

    #[cfg(target_os = "macos")]
    let menu = Menu::with_items(app, &[&parrot, &file, &edit, &view, &practice, &window])?;
    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(app, &[&file, &edit, &practice, &window])?;
    app.set_menu(menu)?;
    app.manage(Items(items));
    // the system's items act by themselves; one of Parrot's own is for the window
    app.on_menu_event(|app, event| {
        let _ = app.emit("menu", event.id().0.as_str());
    });
    Ok(())
}

/// The window says which screen it shows: the items that act on a screen are enabled on it alone.
#[tauri::command]
pub fn set_screen(items: State<'_, Items>, screen: String) {
    for each in &items.0 {
        let _ = each.item.set_enabled(each.screens.contains(&screen.as_str()));
    }
}
