using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace ShadowTray;

/// <summary>Coloured circle icons drawn at start-up (no icon files in the repo).</summary>
public sealed class TrayIcons : IDisposable
{
    private readonly Dictionary<TrayColour, Icon> _icons = new();

    public TrayIcons(int size)
    {
        _icons[TrayColour.Green] = Circle(size, Color.FromArgb(46, 194, 96));
        _icons[TrayColour.Yellow] = Circle(size, Color.FromArgb(245, 190, 30));
        _icons[TrayColour.Red] = Circle(size, Color.FromArgb(220, 50, 50));
        _icons[TrayColour.Blue] = Circle(size, Color.FromArgb(50, 130, 220));
    }

    public Icon this[TrayColour colour] => _icons[colour];

    private static Icon Circle(int size, Color fill)
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
