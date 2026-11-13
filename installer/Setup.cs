// SPDX-License-Identifier: GPL-3.0-or-later

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed class DiscordTarget
{
    internal readonly string Name;
    internal readonly string Folder;
    internal readonly string ProcessName;

    internal DiscordTarget(string name, string folder, string processName)
    {
        Name = name;
        Folder = folder;
        ProcessName = processName;
    }

    public override string ToString()
    {
        return Name;
    }
}

internal static class Setup
{
    private static readonly Assembly Assembly = typeof(Setup).Assembly;
    private static readonly string[] DiscordExecutables = {
        "Discord", "DiscordPTB", "DiscordCanary", "DiscordDevelopment"
    };

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupWindow());
    }

    internal static string ReadResource(string name)
    {
        using (var reader = new StreamReader(Assembly.GetManifestResourceStream(name), Encoding.UTF8))
            return reader.ReadToEnd().Trim();
    }

    internal static DiscordTarget[] FindDiscords()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] names = { "Discord", "Discord PTB", "Discord Canary", "Discord Development" };
        return DiscordExecutables.Select((exe, index) =>
            new DiscordTarget(names[index], Path.Combine(local, exe), exe))
            .Where(target => FindResources(target.Folder) != null).ToArray();
    }

    internal static string FindResources(string folder)
    {
        if (!Directory.Exists(folder)) return null;
        try
        {
            // Match the official Windows installer's app-* directory ordering.
            return Directory.EnumerateDirectories(folder, "app-*")
                .Select(path => Path.Combine(path, "resources"))
                .Where(Directory.Exists)
                .OrderByDescending(path => path, StringComparer.Ordinal)
                .FirstOrDefault();
        }
        catch (UnauthorizedAccessException) { return null; }
        catch (IOException) { return null; }
    }

    private static void Extract(string resource, string path)
    {
        using (var source = Assembly.GetManifestResourceStream(resource))
        using (var destination = File.Create(path))
            source.CopyTo(destination);
    }

    private static string FindExecutable(DiscordTarget target, string resources)
    {
        var names = target.ProcessName == null ? DiscordExecutables : new[] { target.ProcessName };
        string appFolder = Path.GetDirectoryName(resources);
        return names.Select(name => Path.Combine(appFolder, name + ".exe")).FirstOrDefault(File.Exists);
    }

    private static void CloseDiscord(DiscordTarget target, string executable)
    {
        string folder = Path.GetFullPath(target.Folder).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string name = Path.GetFileNameWithoutExtension(executable);
        int session;
        using (var current = Process.GetCurrentProcess()) session = current.SessionId;
        var processes = Process.GetProcessesByName(name);
        try
        {
            var matching = processes.Where(process =>
            {
                try
                {
                    if (process.HasExited || process.SessionId != session) return false;
                    string path = process.MainModule.FileName;
                    string appFolder = Path.GetDirectoryName(path);
                    return string.Equals(Path.GetDirectoryName(appFolder) + Path.DirectorySeparatorChar, folder,
                        StringComparison.OrdinalIgnoreCase)
                        && Path.GetFileName(appFolder).StartsWith("app-", StringComparison.OrdinalIgnoreCase);
                }
                catch (InvalidOperationException) { return false; }
                catch (Win32Exception)
                {
                    if (process.HasExited) return false;
                    throw;
                }
            }).ToArray();

            foreach (var process in matching)
            {
                try
                {
                    if (process.HasExited) continue;
                    if (process.CloseMainWindow() && process.WaitForExit(3000)) continue;
                    if (!process.HasExited) process.Kill();
                    if (!process.WaitForExit(5000))
                        throw new TimeoutException("Discord не завершил работу. Закройте его и повторите попытку.");
                }
                catch (InvalidOperationException) { if (!process.HasExited) throw; }
                catch (Win32Exception) { if (!process.HasExited) throw; }
            }
        }
        finally
        {
            foreach (var process in processes) process.Dispose();
        }
    }

    internal static void LaunchDiscord(string executable)
    {
        using (var process = Process.Start(new ProcessStartInfo(executable) {
            WorkingDirectory = Path.GetDirectoryName(executable),
            UseShellExecute = true
        }))
        {
            if (process == null) throw new InvalidOperationException("Не удалось запустить Discord.");
        }
    }

    internal static string Install(DiscordTarget target, string data, string legacyData, IProgress<int> progress)
    {
        string resources = FindResources(target.Folder);
        if (resources == null || !File.Exists(Path.Combine(resources, "app.asar")))
            throw new InvalidOperationException("В выбранной папке не найдена установка Discord.");
        string executable = FindExecutable(target, resources);
        if (executable == null)
            throw new InvalidOperationException("В выбранной папке не найден исполняемый файл Discord.");

        Directory.CreateDirectory(data);
        using (var installLock = new FileStream(Path.Combine(data, "install.lock"), FileMode.OpenOrCreate,
            FileAccess.ReadWrite, FileShare.None))
        {
            string versions = Path.Combine(data, "versions");
            Directory.CreateDirectory(versions);
            string bundleId = ReadResource("BundleId");
            string version = Path.Combine(versions, bundleId);
            string temporary = Path.Combine(data, "setup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temporary);
            try
            {
                if (!Directory.Exists(version))
                {
                    string archive = Path.Combine(temporary, "bundle.zip");
                    string staged = Path.Combine(temporary, "version");
                    Extract("Bundle", archive);
                    progress.Report(30);
                    ZipFile.ExtractToDirectory(archive, staged);
                    Directory.Move(staged, version);
                }
                progress.Report(75);

                MigrateUserPlugins(data, legacyData);
                string helper = Path.Combine(temporary, "VencordInstallerCli.exe");
                Extract("VencordInstallerCli", helper);
                string current = Path.Combine(version, ".vencord-ru", "current");
                if (!File.Exists(Path.Combine(current, "dist", "patcher.js")))
                    throw new InvalidOperationException("Не удалось найти файлы сборки Vencord RU.");
                CloseDiscord(target, executable);
                InstallLauncher(helper, target.Folder, data, bundleId, temporary);
                progress.Report(100);
            }
            finally
            {
                try { Directory.Delete(temporary, true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
        return executable;
    }

    private static void MigrateUserPlugins(string data, string legacyData)
    {
        string source = Path.Combine(legacyData, "userplugins");
        string destination = Path.Combine(data, "userplugins");
        string marker = Path.Combine(data, ".vencord-ru-plugins-migrated");
        if (File.Exists(marker) || !Directory.Exists(source)) return;

        CopyMissingFiles(source, destination);
        File.WriteAllText(marker, "");
    }

    private static void CopyMissingFiles(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (string path in Directory.EnumerateFileSystemEntries(source))
        {
            var attributes = File.GetAttributes(path);
            string name = Path.GetFileName(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0 || name == ".git" || name == "node_modules") continue;
            string target = Path.Combine(destination, name);
            if ((attributes & FileAttributes.Directory) != 0)
            {
                if (!File.Exists(target) && (!Directory.Exists(target) || (File.GetAttributes(target) & FileAttributes.ReparsePoint) == 0))
                    CopyMissingFiles(path, target);
            }
            else if (!File.Exists(target) && !Directory.Exists(target))
            {
                File.Copy(path, target);
            }
        }
    }

    private static void InstallLauncher(string helper, string discord, string data, string bundleId, string temporary)
    {
        string dist = Path.Combine(data, "dist");
        Directory.CreateDirectory(dist);
        string package = Path.Combine(dist, "package.json");
        if (!File.Exists(package)) File.WriteAllText(package, "{\"type\":\"commonjs\"}", Encoding.ASCII);

        string entry = Path.Combine(dist, "patcher.js");
        string staged = Path.Combine(temporary, "patcher.js");
        string backup = Path.Combine(temporary, "previous-patcher.js");
        File.WriteAllText(staged, "require('../versions/" + bundleId + "/.vencord-ru/current/dist/patcher.js');\n", Encoding.ASCII);
        bool hadEntry = File.Exists(entry);
        if (hadEntry)
            File.Replace(staged, entry, backup);
        else
            File.Move(staged, entry);

        try
        {
            Patch(helper, discord, data, Path.Combine(data, "install.log"));
        }
        catch
        {
            if (hadEntry)
                File.Replace(backup, entry, null);
            else
                File.Delete(entry);
            throw;
        }
    }

    private static void Patch(string helper, string discord, string version, string log)
    {
        var info = new ProcessStartInfo(helper, "--install --location \"" + discord.TrimEnd('\\') + "\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(helper),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        info.EnvironmentVariables["VENCORD_DEV_INSTALL"] = "1";
        info.EnvironmentVariables["VENCORD_USER_DATA_DIR"] = version;

        using (Process process = Process.Start(info))
        {
            Task<string> output = process.StandardOutput.ReadToEndAsync();
            Task<string> errors = process.StandardError.ReadToEndAsync();
            process.WaitForExit();
            File.WriteAllText(log, output.GetAwaiter().GetResult() + errors.GetAwaiter().GetResult(), Encoding.UTF8);
            if (process.ExitCode != 0)
                throw new InvalidOperationException("Установщик Vencord завершился с ошибкой. Журнал: " + log);
        }
    }
}

internal sealed class SetupWindow : Form
{
    private readonly ComboBox targets = new SetupComboBox();
    private readonly Label status = new Label();
    private readonly SetupProgress installationProgress = new SetupProgress();
    private readonly Button install = new SetupButton(primary: true);
    private readonly Button browse = new SetupButton();
    private readonly Button close = new SetupButton();
    private bool installing;

    internal SetupWindow()
    {
        Text = "Установка Vencord RU";
        var windowIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Icon = windowIcon;
        Disposed += (sender, args) => { if (windowIcon != null) windowIcon.Dispose(); };
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        AutoScaleMode = AutoScaleMode.Font;
        Font = new Font("Segoe UI", 10);
        ClientSize = new Size(530, 245);
        BackColor = SetupTheme.Background;
        ForeColor = SetupTheme.Text;

        var logo = new PictureBox {
            Bounds = new Rectangle(22, 15, 43, 43),
            SizeMode = PictureBoxSizeMode.Zoom
        };
        using (var icon = typeof(Setup).Assembly.GetManifestResourceStream("VencordLogo"))
        using (var bitmap = Image.FromStream(icon))
            logo.Image = new Bitmap(bitmap);
        logo.Disposed += (sender, args) => logo.Image.Dispose();
        var heading = new Label {
            Text = "Vencord на русском", Font = new Font(Font.FontFamily, 19, FontStyle.Bold),
            Bounds = new Rectangle(75, 17, 433, 40)
        };
        var hint = new Label {
            Text = "Выбранный Discord закроется перед установкой и откроется после неё.",
            Bounds = new Rectangle(22, 67, 486, 40),
            ForeColor = SetupTheme.Muted
        };
        targets.Bounds = new Rectangle(22, 115, 355, 32);
        targets.DropDownStyle = ComboBoxStyle.DropDownList;
        targets.DrawMode = DrawMode.OwnerDrawFixed;
        targets.FlatStyle = FlatStyle.Flat;
        targets.ItemHeight = 26;
        targets.BackColor = SetupTheme.Field;
        targets.ForeColor = SetupTheme.Text;
        targets.AccessibleName = "Установка Discord";
        targets.DrawItem += DrawDiscordTarget;
        targets.Items.AddRange(Setup.FindDiscords());
        targets.SelectedIndexChanged += (sender, args) => RefreshTarget();
        installationProgress.Bounds = targets.Bounds;
        installationProgress.Visible = false;

        browse.Text = "Выбрать папку";
        browse.Bounds = new Rectangle(388, 114, 120, 32);
        browse.Click += (sender, args) => Browse();

        status.Bounds = new Rectangle(22, 157, 486, 37);
        status.AutoEllipsis = true;
        status.ForeColor = SetupTheme.Muted;

        close.Text = "Закрыть";
        close.Bounds = new Rectangle(407, 201, 101, 32);
        close.Click += (sender, args) => Close();
        CancelButton = close;

        install.Text = "Установить";
        install.Bounds = new Rectangle(290, 201, 108, 32);
        install.Click += Install;
        AcceptButton = install;

        Controls.AddRange(new Control[] { logo, heading, hint, targets, installationProgress, browse, status, close, install });
        if (targets.Items.Count > 0) targets.SelectedIndex = 0;
        RefreshTarget();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        SetupTheme.SetDarkTitleBar(Handle);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (installing) e.Cancel = true;
        base.OnFormClosing(e);
    }

    private void RefreshTarget()
    {
        var target = targets.SelectedItem as DiscordTarget;
        install.Enabled = target != null;
        status.Text = target == null ? "Discord не найден. Выберите папку с установленным Discord." : target.Folder;
    }

    private void Browse()
    {
        var selected = targets.SelectedItem as DiscordTarget;
        string folder;
        try
        {
            folder = FolderPicker.Show(Handle, selected == null ? null : selected.Folder);
        }
        catch (COMException error)
        {
            SetupNotice.Show(this, "Не удалось открыть Проводник", error.Message);
            return;
        }
        if (folder == null) return;
        if (Setup.FindResources(folder) == null)
        {
            SetupNotice.Show(this, "Discord не найден", "Выберите папку, в которой находится каталог app-…", warning: true);
            return;
        }
        var target = new DiscordTarget("Discord — " + Path.GetFileName(folder), folder, null);
        targets.Items.Add(target);
        targets.SelectedItem = target;
    }

    private void DrawDiscordTarget(object sender, DrawItemEventArgs e)
    {
        if ((e.State & DrawItemState.ComboBoxEdit) != 0) return;
        bool dropdownSelection = (e.State & DrawItemState.Selected) != 0;
        using (var background = new SolidBrush(dropdownSelection ? Color.FromArgb(58, 60, 66) : SetupTheme.Field))
            e.Graphics.FillRectangle(background, e.Bounds);

        var text = e.Index < 0 ? "" : targets.GetItemText(targets.Items[e.Index]);
        var bounds = e.Bounds;
        bounds.Inflate(-7, 0);
        TextRenderer.DrawText(e.Graphics, text, Font, bounds, targets.Enabled ? SetupTheme.Text : SetupTheme.Muted,
            TextFormatFlags.EndEllipsis | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }

    private async void Install(object sender, EventArgs e)
    {
        var target = targets.SelectedItem as DiscordTarget;
        if (target == null || installing) return;
        installing = true;
        targets.Enabled = browse.Enabled = close.Enabled = install.Enabled = false;
        status.Text = "Устанавливается Vencord RU…";
        string executable;
        try
        {
            string discordData = Environment.GetEnvironmentVariable("DISCORD_USER_DATA_DIR");
            string data = string.IsNullOrEmpty(discordData)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Vencord")
                : Path.GetFullPath(Path.Combine(discordData, "..", "VencordData"));
            string legacyData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Vencord-RU");
            installationProgress.SetProgress(0);
            targets.Hide();
            installationProgress.Show();
            var progress = new Progress<int>(value => {
                if (installing) installationProgress.SetProgress(value);
            });
            executable = await Task.Run(() => Setup.Install(target, data, legacyData, progress));
        }
        catch (Exception error)
        {
            status.Text = "Установка не завершена.";
            SetupNotice.Show(this, "Установка не завершена", error.Message);
            return;
        }
        finally
        {
            installing = false;
            installationProgress.Hide();
            targets.Show();
            targets.Enabled = browse.Enabled = close.Enabled = install.Enabled = true;
        }
        try
        {
            Setup.LaunchDiscord(executable);
        }
        catch (Exception error)
        {
            status.Text = "Vencord RU установлен. Откройте Discord вручную.";
            SetupNotice.Show(this, "Vencord RU установлен", "Откройте Discord вручную. " + error.Message, warning: true);
            return;
        }
        Close();
    }
}
