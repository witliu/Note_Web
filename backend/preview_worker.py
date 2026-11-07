"""Isolated RAW decoder. Read original bytes on stdin, write only a JPEG to stdout."""
import io
import sys

MAX_BYTES = 128 * 1024 * 1024
MAX_PIXELS = 100_000_000


def jpeg(image):
    from PIL import Image, ImageOps
    if image.width * image.height > MAX_PIXELS:
        raise ValueError('Image too large')
    image = ImageOps.exif_transpose(image)
    image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.convert('RGB').save(output, format='JPEG', quality=88, optimize=True)
    return output.getvalue()


def convert(data):
    import rawpy
    from PIL import Image
    # Opening without unpacking permits extracting embedded previews first.
    with rawpy.RawPy() as raw:
        raw.open_buffer(io.BytesIO(data))
        if raw.sizes.raw_width * raw.sizes.raw_height > MAX_PIXELS:
            raise ValueError('RAW image too large')
        try:
            thumb = raw.extract_thumb()
            image = Image.open(io.BytesIO(thumb.data)) if thumb.format == rawpy.ThumbFormat.JPEG else Image.fromarray(thumb.data)
            return jpeg(image)
        except (rawpy.LibRawNoThumbnailError, rawpy.LibRawUnsupportedThumbnailError, OSError, ValueError):
            raw.unpack()
            rgb = raw.postprocess(half_size=True, use_camera_wb=True, output_bps=8)
            return jpeg(Image.fromarray(rgb))


if __name__ == '__main__':
    try:
        data = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError('RAW file too large')
        sys.stdout.buffer.write(convert(data))
    except Exception:
        # Do not log filenames, image metadata, or original bytes.
        sys.stderr.write('RAW preview conversion failed\n')
        sys.exit(1)
