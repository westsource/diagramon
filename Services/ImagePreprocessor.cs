using System;
using System.IO;

using Avalonia;
using Avalonia.Media.Imaging;

namespace Diagramon.Services;

/// <summary>
/// 把用户选的图片压到服务端能收的尺寸与体积。
/// </summary>
/// <remarks>
/// <para>
/// 服务端上限：<b>单张 base64 ≤ 1 MiB</b>（<c>ai_max_image_bytes</c>；校验的是 data URL 的
/// <b>字符数</b>，见 <c>gateway.collect_images</c>）。base64 会膨胀 4/3，所以原图字节要 ≤ ~750 KB。
/// </para>
/// <para>
/// 梯度：<b>1600 PNG → 1280 PNG → 1280 JPEG q85</b>（方案 §6.6 第 3 步）。
/// 前两档无损 —— 图表截图是平坦色块，PNG 又小又清楚，本来就该走 PNG；JPEG 只是<b>兜底</b>，
/// 它有块效应、细线小字会糊，不到最后一档不用。三档都超才报错（说明该先裁剪）。
/// </para>
/// </remarks>
public static class ImagePreprocessor
{
    /// <summary>第一档长边上限。</summary>
    public const int MaxLongEdge = 1600;

    /// <summary>第二档（第一档仍超体积时用）。</summary>
    public const int RetryLongEdge = 1280;

    /// <summary>单张原图字节上限（base64 后约 1 MiB）。</summary>
    public const int MaxBytes = 750_000;

    /// <summary>JPEG 兜底档的质量。</summary>
    public const int JpegQuality = 85;

    /// <summary>可交给 <c>CloudAIService</c> 的图片载荷。</summary>
    public sealed record Prepared(byte[] Data, string MediaType, int Width, int Height);

    /// <summary>
    /// 读入 → 按需缩放 → 编码。三档都超时抛 <see cref="InvalidOperationException"/>，
    /// 消息可直接展示给用户（文案层由调用方决定）。
    /// </summary>
    /// <param name="source">可 seek 的图片流（本地文件或剪贴板位图都行）。</param>
    public static Prepared Prepare(Stream source)
    {
        ArgumentNullException.ThrowIfNull(source);

        var mediaType = "image/png";

        var bitmap = Decode(source, MaxLongEdge);
        var data = EncodePng(bitmap);

        if (data.Length > MaxBytes)
        {
            bitmap.Dispose();
            bitmap = Decode(source, RetryLongEdge);
            data = EncodePng(bitmap);
        }

        if (data.Length > MaxBytes)
        {
            // 兜底：有损，但至少送得出去。取更小的那个（个别图 JPEG 反而更大）。
            var lossy = EncodeJpeg(bitmap, JpegQuality);
            if (lossy.Length < data.Length)
            {
                data = lossy;
                mediaType = "image/jpeg";
            }
        }

        var result = new Prepared(data, mediaType, bitmap.PixelSize.Width, bitmap.PixelSize.Height);
        bitmap.Dispose();

        if (data.Length > MaxBytes)
        {
            throw new InvalidOperationException(
                $"图片压缩后仍有 {data.Length / 1024} KB（上限 {MaxBytes / 1024} KB，" +
                $"已降到 {result.Width}×{result.Height} 并试过 JPEG）。请先裁剪到图表主体再试。");
        }

        return result;
    }

    /// <summary>按长边上限等比缩放；本身就不超则原样返回。</summary>
    private static Bitmap Decode(Stream source, int longEdge)
    {
        // 第二档要重读一次，所以流必须可 seek（调用方保证）
        source.Position = 0;

        var original = new Bitmap(source);
        var width = original.PixelSize.Width;
        var height = original.PixelSize.Height;
        var longest = Math.Max(width, height);

        if (longest <= longEdge)
        {
            return original;
        }

        var scale = (double)longEdge / longest;
        var target = new PixelSize(
            Math.Max(1, (int)Math.Round(width * scale)),
            Math.Max(1, (int)Math.Round(height * scale)));

        var scaled = original.CreateScaledBitmap(target, BitmapInterpolationMode.HighQuality);
        original.Dispose();
        return scaled;
    }

    /// <summary>无参 <c>Save</c> 就是 PNG。</summary>
    private static byte[] EncodePng(Bitmap bitmap)
    {
        using var buffer = new MemoryStream();
        bitmap.Save(buffer);
        return buffer.ToArray();
    }

    /// <summary>带质量参数的 <c>Save</c> 是 JPEG（Avalonia 的约定）。</summary>
    private static byte[] EncodeJpeg(Bitmap bitmap, int quality)
    {
        using var buffer = new MemoryStream();
        bitmap.Save(buffer, quality);
        return buffer.ToArray();
    }
}
