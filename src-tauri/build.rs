fn main() {
    // the Intel Mac build links ONNX Runtime as a library shipped inside the app (Contents/Frameworks)
    if std::env::var("TARGET").as_deref() == Ok("x86_64-apple-darwin") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }
    tauri_build::build()
}
