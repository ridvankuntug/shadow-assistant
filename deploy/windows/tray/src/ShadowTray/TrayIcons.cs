using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace ShadowTray;

/// <summary>
/// Coloured circle icons drawn at start-up (no icon files in the repo); each
/// colour also with a dark pause mark for game mode (whisper-svc paused), and
/// each of those also with a notification dot (unread notifications; docs/08 "Tray").
/// </summary>
public sealed class TrayIcons : IDisposable
{
    private readonly Dictionary<(TrayColour, bool, bool), Icon> _icons = new();

    public TrayIcons(int size)
    {
        foreach (var gameMode in new[] { false, true })
        foreach (var dot in new[] { false, true })
        {
            _icons[(TrayColour.Green, gameMode, dot)] = Circle(size, Color.FromArgb(46, 194, 96), gameMode, dot);
            _icons[(TrayColour.Yellow, gameMode, dot)] = Circle(size, Color.FromArgb(245, 190, 30), gameMode, dot);
            _icons[(TrayColour.Red, gameMode, dot)] = Circle(size, Color.FromArgb(220, 50, 50), gameMode, dot);
            _icons[(TrayColour.Blue, gameMode, dot)] = Circle(size, Color.FromArgb(50, 130, 220), gameMode, dot);
        }
    }

    public Icon this[TrayColour colour, bool gameMode = false, bool notificationDot = false] => _icons[(colour, gameMode, notificationDot)];

    private static Icon Circle(int size, Color fill, bool pauseMark, bool dot)
    {
        using var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            var inset = Math.Max(1f, size / 16f);
            var rect = new RectangleF(inset, inset, size - 2 * inset - 1, size - 2 * inset - 1);
            using var brush = new SolidBrush(fill);
            g.FillEllipse(brush, rect);
            using var pen = new Pen(Color.FromArgb(160, 0, 0, 0), Math.Max(1f, size / 16f));
            g.DrawEllipse(pen, rect);
            if (pauseMark)
            {
                // Two vertical bars ("paused"), dark so they show on every colour.
                using var bars = new SolidBrush(Color.FromArgb(220, 20, 20, 20));
                var w = Math.Max(2f, size * 0.14f);
                var h = size * 0.46f;
                var top = (size - h) / 2f;
                g.FillRectangle(bars, size / 2f - w * 1.5f, top, w, h);
                g.FillRectangle(bars, size / 2f + w * 0.5f, top, w, h);
            }
            if (dot)
            {
                // Top-right corner, white with a dark ring so it shows on every
                // colour and over the pause mark's corner.
                var d = Math.Max(5f, size * 0.42f);
                var dotRect = new RectangleF(size - d - 0.5f, 0.5f, d, d);
                using var dotFill = new SolidBrush(Color.White);
                g.FillEllipse(dotFill, dotRect);
                using var ring = new Pen(Color.FromArgb(230, 20, 20, 20), Math.Max(1f, size / 16f));
                g.DrawEllipse(ring, dotRect);
            }
        }
        var handle = bmp.GetHicon();
        try
        {
            // FromHandle does not own the handle; the clone does.
            using var borrowed = Icon.FromHandle(handle);
            return (Icon)borrowed.Clone();
        }
        finally
        {
            Native.DestroyIcon(handle);
        }
    }

    public void Dispose()
    {
        foreach (var icon in _icons.Values) icon.Dispose();
        _icons.Clear();
    }
}
