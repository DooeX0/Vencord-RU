// SPDX-License-Identifier: GPL-3.0-or-later

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Media;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class SetupTheme
{
    internal static readonly Color Background = Color.FromArgb(30, 31, 34);
    internal static readonly Color Field = Color.FromArgb(43, 45, 49);
    internal static readonly Color Text = Color.FromArgb(242, 243, 245);
    internal static readonly Color Muted = Color.FromArgb(181, 186, 193);
    internal static readonly Color Accent = Color.FromArgb(239, 182, 203);
    internal static readonly Color Border = Color.FromArgb(66, 69, 75);

    internal static void SetDarkTitleBar(IntPtr window)
    {
        const int UseImmersiveDarkMode = 20;
        const int LegacyUseImmersiveDarkMode = 19;
        int enabled = 1;
        if (DwmSetWindowAttribute(window, UseImmersiveDarkMode, ref enabled, sizeof(int)) != 0)
            DwmSetWindowAttribute(window, LegacyUseImmersiveDarkMode, ref enabled, sizeof(int));
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
}

internal sealed class SetupNotice : Form
{
    internal SetupNotice(string title, string message)
    {
        Text = "Установка Vencord RU";
        Font = new Font("Segoe UI", 10);
        AutoScaleMode = AutoScaleMode.Font;
        BackColor = SetupTheme.Background;
        ForeColor = SetupTheme.Text;
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        ShowInTaskbar = false;
        MinimizeBox = false;
        MaximizeBox = false;

        const int width = 410;
        const int padding = 22;
        var heading = new Label {
            Text = title,
            Font = new Font(Font.FontFamily, 14, FontStyle.Bold),
            ForeColor = SetupTheme.Accent,
            Bounds = new Rectangle(padding, 18, width - 2 * padding, 28)
        };
        var body = new Label {
            Text = message,
            Font = Font,
            UseMnemonic = false,
            ForeColor = SetupTheme.Text,
            MaximumSize = new Size(width - 2 * padding - SystemInformation.VerticalScrollBarWidth, 0),
            AutoSize = true
        };
        var content = new Panel {
            AutoScroll = true,
            Bounds = new Rectangle(padding, 54, width - 2 * padding, Math.Min(body.PreferredHeight + 4, 165))
        };
        content.Controls.Add(body);

        var confirm = new SetupButton(primary: true) {
            Text = "Понятно",
            DialogResult = DialogResult.OK,
            Bounds = new Rectangle(width - padding - 100, content.Bottom + 16, 100, 32)
        };
        ClientSize = new Size(width, confirm.Bottom + padding);
        Controls.AddRange(new Control[] { heading, content, confirm });
        AcceptButton = CancelButton = confirm;
        ActiveControl = confirm;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        SetupTheme.SetDarkTitleBar(Handle);
    }

    internal static void Show(Form owner, string title, string message, bool warning = false)
    {
        using (var notice = new SetupNotice(title, message))
        {
            notice.Shown += (sender, args) => (warning ? SystemSounds.Exclamation : SystemSounds.Hand).Play();
            notice.ShowDialog(owner);
        }
    }
}

internal sealed class SetupProgress : Control
{
    private int percent;

    internal SetupProgress()
    {
        DoubleBuffered = true;
        AccessibleRole = AccessibleRole.ProgressBar;
        AccessibleName = "Ход установки Vencord RU";
    }

    internal void SetProgress(int value)
    {
        percent = value;
        AccessibleDescription = value + "%";
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var inner = Rectangle.Inflate(ClientRectangle, -1, -1);
        var fill = new Rectangle(inner.X, inner.Y, inner.Width * percent / 100, inner.Height);
        using (var track = new SolidBrush(SetupTheme.Field))
        using (var accent = new SolidBrush(SetupTheme.Accent))
        using (var border = new Pen(SetupTheme.Border))
        {
            e.Graphics.FillRectangle(track, ClientRectangle);
            e.Graphics.FillRectangle(accent, fill);
            e.Graphics.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
        }
    }
}

internal sealed class SetupComboBox : ComboBox
{
    protected override void OnDropDown(EventArgs e)
    {
        base.OnDropDown(e);
        Invalidate();
    }

    protected override void OnDropDownClosed(EventArgs e)
    {
        base.OnDropDownClosed(e);
        Invalidate();
    }

    protected override void WndProc(ref Message message)
    {
        const int Paint = 0x000f;
        const int EraseBackground = 0x0014;
        const int Print = 0x0317;
        const int PrintClient = 0x0318;
        if (message.Msg == EraseBackground)
        {
            message.Result = new IntPtr(1);
            return;
        }

        if (message.Msg == Paint && IsHandleCreated)
        {
            IntPtr window = Handle;
            PaintState paint;
            IntPtr dc = BeginPaint(window, out paint);
            try
            {
                if (dc != IntPtr.Zero && Width > 0 && Height > 0)
                {
                    using (var graphics = Graphics.FromHdc(dc))
                    using (var buffer = BufferedGraphicsManager.Current.Allocate(graphics, ClientRectangle))
                    {
                        DrawField(buffer.Graphics);
                        buffer.Render(graphics);
                    }
                }
            }
            finally
            {
                EndPaint(window, ref paint);
            }
            message.Result = IntPtr.Zero;
            return;
        }

        if ((message.Msg == Print || message.Msg == PrintClient) && message.WParam != IntPtr.Zero)
        {
            using (var graphics = Graphics.FromHdc(message.WParam)) DrawField(graphics);
            message.Result = IntPtr.Zero;
            return;
        }

        base.WndProc(ref message);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PaintState
    {
        internal IntPtr DeviceContext;
        internal int Erase;
        internal Rectangle PaintRectangle;
        internal int Restore;
        internal int Update;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
        internal byte[] Reserved;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr BeginPaint(IntPtr window, out PaintState paint);

    [DllImport("user32.dll")]
    private static extern bool EndPaint(IntPtr window, ref PaintState paint);

    private void DrawField(Graphics graphics)
    {
        using (var fill = new SolidBrush(SetupTheme.Field))
        using (var border = new Pen(Focused ? SetupTheme.Accent : SetupTheme.Border))
        using (var arrow = new Pen(SetupTheme.Muted, 1.5f))
        {
            graphics.FillRectangle(fill, ClientRectangle);
            graphics.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            int x = Width - 15;
            int y = Height / 2;
            int step = DroppedDown ? -2 : 2;
            graphics.DrawLines(arrow, new[] {
                new Point(x - 4, y - step), new Point(x, y + step), new Point(x + 4, y - step)
            });
        }
        TextRenderer.DrawText(graphics, GetItemText(SelectedItem), Font, new Rectangle(8, 0, Width - 36, Height),
            Enabled ? SetupTheme.Text : SetupTheme.Muted,
            TextFormatFlags.EndEllipsis | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
    }
}

internal sealed class SetupButton : Button
{
    private readonly bool primary;
    private bool hovered;
    private bool pressed;

    internal SetupButton(bool primary = false)
    {
        this.primary = primary;
        FlatStyle = FlatStyle.Flat;
        Cursor = Cursors.Hand;
        MouseEnter += (sender, args) => { hovered = true; Invalidate(); };
        MouseLeave += (sender, args) => { hovered = false; pressed = false; Invalidate(); };
        MouseDown += (sender, args) => { pressed = args.Button == MouseButtons.Left; Invalidate(); };
        MouseUp += (sender, args) => { pressed = false; Invalidate(); };
        GotFocus += (sender, args) => Invalidate();
        LostFocus += (sender, args) => Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(SetupTheme.Background);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        bool active = Enabled && primary;
        Color fill = active
            ? pressed ? Color.FromArgb(213, 147, 173) : hovered ? Color.FromArgb(249, 203, 220) : SetupTheme.Accent
            : Enabled && hovered ? Color.FromArgb(59, 62, 68) : SetupTheme.Field;
        Color text = active ? SetupTheme.Background : Enabled ? SetupTheme.Text : SetupTheme.Muted;

        const int diameter = 12;
        var bounds = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var outline = new GraphicsPath())
        using (var brush = new SolidBrush(fill))
        using (var border = new Pen(Focused && ShowFocusCues ? SetupTheme.Accent : active ? fill : SetupTheme.Border))
        {
            outline.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
            outline.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
            outline.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            outline.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            outline.CloseFigure();
            e.Graphics.FillPath(brush, outline);
            e.Graphics.DrawPath(border, outline);
        }
        TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, text,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }
}
