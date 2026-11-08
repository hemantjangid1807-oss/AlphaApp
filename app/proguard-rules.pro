# Keep the JavaScript bridge methods if you enable minification.
-keepclassmembers class com.brainsim.app.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
