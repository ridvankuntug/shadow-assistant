using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace ShadowTray;

/// <summary>
/// Coloured circle icons drawn at start-up (no icon files in the repo); each
/// colour also with a dark pause mark for game mode (whisper-svc paused).
/// </summary>
public sealed class TrayIcons : IDisposable
{
    private readonly Dictionary<(TrayColour, bool), Icon> _icons = new();

    public TrayIcons(int size)
    {
        foreach (var gameMode in new[] { false, true })
        {
            _icons[(TrayColour.Green, gameMode)] = Circle(size, Color.FromArgb(46, 194, 96), gameMode);
            _icons[(TrayColour.Yellow, gameMode)] = Circle(size, Color.FromArgb(245, 190, 30), gameMode);
            _icons[(TrayColour.Red, gameMode)] = Circle(size, Color.FromArgb(220, 50, 50), gameMode);
            _icons[(TrayColour.Blue, gameMode)] = Circle(size, Color.FromArgb(50, 130, 220), gameMode);
        }
    }

    public Icon this[TrayColour colour, bool gameMode = false] => _icons[(colour, gameMode)];

    private static Icon Circle(int size, Color fill, bool pauseMark)
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
