function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fallbackHash(bytes: Uint8Array): string {
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
        hash = Math.imul(hash ^ byte, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
    try {
        const digestInput = new Uint8Array(bytes.byteLength);
        digestInput.set(bytes);
        const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
        return bytesToHex(new Uint8Array(digest));
    } catch {
        return fallbackHash(bytes);
    }
}

export async function generateHash(text: string): Promise<string> {
    return hashBytes(new TextEncoder().encode(text));
}

export async function generateBinaryHash(buffer: ArrayBuffer): Promise<string> {
    return hashBytes(new Uint8Array(buffer));
}
