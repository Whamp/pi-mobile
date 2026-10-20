package dev.whamp.p2w;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

final class RuntimeInstaller {
    final File app;
    final File home;
    final File workspace;
    final File temporary;
    final File data;
    final String nativeDirectory;

    private RuntimeInstaller(Context context) {
        File files = context.getFilesDir();
        app = new File(files, "app");
        home = new File(files, "home");
        workspace = new File(home, "workspace");
        temporary = new File(files, "tmp");
        data = new File(files, "mobile");
        nativeDirectory = context.getApplicationInfo().nativeLibraryDir;
    }

    static RuntimeInstaller install(Context context) throws IOException {
        RuntimeInstaller layout = new RuntimeInstaller(context);
        for (File directory : new File[]{layout.home, layout.workspace, layout.temporary, layout.data}) {
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create " + directory);
        }
        String version;
        try (var input = context.getAssets().open("app-version.txt")) {
            version = new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
        File marker = new File(layout.app, ".installed-version");
        if (marker.isFile() && new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8).equals(version)) return layout;
        File staging = new File(context.getFilesDir(), "app-staging");
        delete(staging);
        if (!staging.mkdirs()) throw new IOException("Cannot create app staging directory");
        String prefix = staging.getCanonicalPath() + File.separator;
        try (ZipInputStream zip = new ZipInputStream(context.getAssets().open("app.zip"))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File target = new File(staging, entry.getName());
                if (!target.getCanonicalPath().startsWith(prefix)) throw new IOException("Invalid asset path");
                if (entry.isDirectory()) {
                    if (!target.isDirectory() && !target.mkdirs()) throw new IOException("Cannot create asset directory");
                } else {
                    File parent = target.getParentFile();
                    if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot create asset parent");
                    try (FileOutputStream output = new FileOutputStream(target)) { zip.transferTo(output); }
                }
                zip.closeEntry();
            }
        }
        Files.write(new File(staging, ".installed-version").toPath(), version.getBytes(StandardCharsets.UTF_8));
        File previous = new File(context.getFilesDir(), "app-previous");
        delete(previous);
        if (layout.app.exists() && !layout.app.renameTo(previous)) throw new IOException("Cannot replace app assets");
        if (!staging.renameTo(layout.app)) throw new IOException("Cannot install app assets");
        delete(previous);
        return layout;
    }

    private static void delete(File file) throws IOException {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        if (!file.delete()) throw new IOException("Cannot remove " + file);
    }

    Process start(boolean fake) throws IOException {
        File log = new File(data, "server.log");
        if (log.length() > 2 * 1024 * 1024) Files.move(log.toPath(), new File(data, "server.previous.log").toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        ProcessBuilder builder = new ProcessBuilder(nativeDirectory + "/libp2w_node.so", new File(app, "src/server/main.js").getPath());
        builder.directory(workspace);
        var env = builder.environment();
        env.put("HOME", home.getPath());
        env.put("TMPDIR", temporary.getPath());
        env.put("TMP", temporary.getPath());
        env.put("TEMP", temporary.getPath());
        env.put("PATH", "/system/bin:/system/xbin");
        env.put("SHELL", "/system/bin/sh");
        env.put("LD_LIBRARY_PATH", nativeDirectory);
        env.put("SSL_CERT_FILE", new File(app, "cert.pem").getPath());
        env.put("NODE_EXTRA_CA_CERTS", new File(app, "cert.pem").getPath());
        env.put("OPENSSL_CONF", new File(app, "openssl.cnf").getPath());
        env.put("PI_MOBILE_DATA_DIR", data.getPath());
        env.put("PI_MOBILE_WEB_DIR", new File(app, "web").getPath());
        env.put("PI_MOBILE_PROFILE", "p2w");
        env.put("PI_MOBILE_RESUME", "1");
        env.put("PI_MOBILE_FAKE", fake ? "1" : "0");
        env.put("PI_MOBILE_DEBUG", BuildConfig.DEBUG ? "1" : "0");
        env.put("PORT", "18787");
        return builder.redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(log)).start();
    }
}
