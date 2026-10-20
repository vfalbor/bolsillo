package app.bolsillo;

import android.system.Os;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.GZIPInputStream;

/** Minimal .tar.gz extractor (files, folders, symlinks, hard links, long names). */
final class TarGz {
    private TarGz() {}

    static void extract(File archive, File dest) throws IOException {
        java.nio.file.Path root = dest.toPath().toAbsolutePath().normalize();
        try (InputStream in = new GZIPInputStream(new FileInputStream(archive), 1 << 16)) {
            byte[] header = new byte[512];
            String longName = null;
            String longLink = null;
            while (readFully(in, header)) {
                if (isZero(header)) break;
                String name = longName != null ? longName : str(header, 0, 100);
                String prefix = str(header, 345, 155);
                if (longName == null && !prefix.isEmpty()) name = prefix + "/" + name;
                String link = longLink != null ? longLink : str(header, 157, 100);
                longName = null;
                longLink = null;
                int mode = (int) octal(header, 100, 8);
                long size = octal(header, 124, 12);
                char type = (char) header[156];

                if (type == 'L' || type == 'K' || type == 'x') {
                    String data = new String(readData(in, size), StandardCharsets.UTF_8);
                    if (type == 'L') longName = trimNul(data);
                    else if (type == 'K') longLink = trimNul(data);
                    else { longName = paxValue(data, "path"); longLink = paxValue(data, "linkpath"); }
                    continue;
                }
                if (type == 'g') { readData(in, size); continue; }

                File out = new File(dest, name);
                // Lexical check: root filesystems have absolute symlinks that must not be resolved here.
                if (!out.toPath().toAbsolutePath().normalize().startsWith(root)) {
                    throw new IOException("Path not allowed in the archive: " + name);
                }
                if (type == '5') {
                    out.mkdirs();
                    chmod(out, mode);
                } else if (type == '2') {
                    out.getParentFile().mkdirs();
                    out.delete();
                    try { Os.symlink(link, out.getPath()); } catch (Exception e) { throw new IOException("symlink " + name + ": " + e.getMessage()); }
                } else if (type == '1') {
                    out.getParentFile().mkdirs();
                    out.delete();
                    Files.copy(new File(dest, link).toPath(), out.toPath());
                    chmod(out, mode);
                } else if (type == '0' || type == 0 || type == '7') {
                    out.getParentFile().mkdirs();
                    out.delete();
                    try (OutputStream os = new FileOutputStream(out)) { copy(in, os, size); }
                    skipPadding(in, size);
                    chmod(out, mode);
                } else {
                    readData(in, size); // devices, fifos: not needed
                }
            }
        }
    }

    private static void chmod(File f, int mode) {
        try { Os.chmod(f.getPath(), mode & 07777); } catch (Exception ignored) { }
    }

    private static boolean readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) return false;
            off += n;
        }
        return true;
    }

    private static byte[] readData(InputStream in, long size) throws IOException {
        byte[] data = new byte[(int) size];
        if (!readFully(in, data)) throw new IOException("Truncated archive");
        skipPadding(in, size);
        return data;
    }

    private static void copy(InputStream in, OutputStream out, long size) throws IOException {
        byte[] buf = new byte[1 << 16];
        while (size > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, size));
            if (n < 0) throw new IOException("Truncated archive");
            out.write(buf, 0, n);
            size -= n;
        }
    }

    private static void skipPadding(InputStream in, long size) throws IOException {
        long pad = (512 - (size % 512)) % 512;
        while (pad > 0) {
            long n = in.skip(pad);
            if (n <= 0) { if (in.read() < 0) return; n = 1; }
            pad -= n;
        }
    }

    private static boolean isZero(byte[] b) {
        for (byte x : b) if (x != 0) return false;
        return true;
    }

    private static String str(byte[] b, int off, int len) {
        int end = off;
        while (end < off + len && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8);
    }

    private static long octal(byte[] b, int off, int len) {
        long v = 0;
        for (int i = off; i < off + len; i++) {
            if (b[i] == 0 || b[i] == ' ') { if (v > 0) break; else continue; }
            v = v * 8 + (b[i] - '0');
        }
        return v;
    }

    private static String trimNul(String s) {
        int i = s.indexOf('\0');
        return i >= 0 ? s.substring(0, i) : s;
    }

    private static String paxValue(String data, String key) {
        for (String line : data.split("\n")) {
            int sp = line.indexOf(' ');
            int eq = line.indexOf('=');
            if (sp > 0 && eq > sp && line.substring(sp + 1, eq).equals(key)) return line.substring(eq + 1);
        }
        return null;
    }
}
