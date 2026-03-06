// Mathematical Bold Unicode ranges
const BOLD_UPPER_START = 0x1D400; // 𝐀
const BOLD_LOWER_START = 0x1D41A; // 𝐚
const BOLD_DIGIT_START = 0x1D7CE; // 𝟎

export function toBold(text: string): string {
    let result = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch >= "A" && ch <= "Z") {
            result += String.fromCodePoint(BOLD_UPPER_START + (ch.charCodeAt(0) - 65));
        } else if (ch >= "a" && ch <= "z") {
            result += String.fromCodePoint(BOLD_LOWER_START + (ch.charCodeAt(0) - 97));
        } else if (ch >= "0" && ch <= "9") {
            result += String.fromCodePoint(BOLD_DIGIT_START + (ch.charCodeAt(0) - 48));
        } else {
            result += ch;
        }
    }
    return result;
}

export function toSlug(text: string): string {
    return text
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
}
