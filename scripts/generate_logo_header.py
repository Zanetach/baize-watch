from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SIZE = 40
PANEL_RGB = (24, 28, 24)
ASSETS = {
    "CODEX_LOGO": ROOT / "server/public/logos/codex-color.png",
    "CLAUDE_LOGO": ROOT / "server/public/logos/claudecode-color.png",
}
TRANSPARENT_KEY = 0xF81F
THREE_D_LOGO_SIZE = 96
THREE_D_ASSETS = {
    "CODEX_3D_LOGO": ROOT / "server/public/logos/codex-3d-cloud-transparent.png",
    "CLAUDE_3D_LOGO": ROOT / "server/public/logos/claudecode-3d-transparent.png",
}
OUTPUT = ROOT / "firmware/include/agent_logos.h"


def rgb565(red, green, blue):
    return ((red & 0xF8) << 8) | ((green & 0xFC) << 3) | (blue >> 3)


def image_to_values(path):
    image = Image.open(path).convert("RGBA").resize((SIZE, SIZE), Image.LANCZOS)
    background = Image.new("RGBA", (SIZE, SIZE), PANEL_RGB + (255,))
    background.alpha_composite(image)
    return [rgb565(red, green, blue) for red, green, blue, _alpha in background.getdata()]


def transparent_image_to_values(path, size):
    image = Image.open(path).convert("RGBA")
    image.thumbnail((size, size), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(image, ((size - image.width) // 2, (size - image.height) // 2))
    values = []
    for red, green, blue, alpha in canvas.getdata():
        if alpha < 80:
            values.append(TRANSPARENT_KEY)
        else:
            values.append(rgb565(red, green, blue))
    return values


def main():
    lines = [
        "#pragma once",
        "",
        "#include <Arduino.h>",
        "",
        f"constexpr int AGENT_LOGO_SIZE = {SIZE};",
        f"constexpr int THREE_D_LOGO_SIZE = {THREE_D_LOGO_SIZE};",
        f"constexpr uint16_t LOGO_TRANSPARENT = 0x{TRANSPARENT_KEY:04X};",
        "",
    ]

    for name, path in ASSETS.items():
        values = image_to_values(path)
        lines.append(f"const uint16_t {name}[AGENT_LOGO_SIZE * AGENT_LOGO_SIZE] PROGMEM = {{")
        for index in range(0, len(values), 10):
            chunk = ", ".join(f"0x{value:04X}" for value in values[index:index + 10])
            comma = "," if index + 10 < len(values) else ""
            lines.append(f"  {chunk}{comma}")
        lines.append("};")
        lines.append("")

    for name, path in THREE_D_ASSETS.items():
        values = transparent_image_to_values(path, THREE_D_LOGO_SIZE)
        lines.append(f"const uint16_t {name}[THREE_D_LOGO_SIZE * THREE_D_LOGO_SIZE] PROGMEM = {{")
        for index in range(0, len(values), 10):
            chunk = ", ".join(f"0x{value:04X}" for value in values[index:index + 10])
            comma = "," if index + 10 < len(values) else ""
            lines.append(f"  {chunk}{comma}")
        lines.append("};")
        lines.append("")

    OUTPUT.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
