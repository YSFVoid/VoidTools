interface NormalizedHttpUrlResult {
    value: string | null;
    error: string | null;
}

export interface ParsedGitHubRepo {
    owner: string;
    repo: string;
    fullName: string;
    repoUrl: string;
    branch: string | null;
}

export function normalizeHttpUrl(value: string, fieldName: string): NormalizedHttpUrlResult {
    const trimmed = value.trim();
    if (!trimmed) {
        return { value: null, error: `${fieldName} is required.` };
    }

    try {
        const parsed = new URL(trimmed);
        if (!["http:", "https:"].includes(parsed.protocol)) {
            return { value: null, error: `${fieldName} must use http or https.` };
        }

        return { value: parsed.toString(), error: null };
    } catch {
        return { value: null, error: `${fieldName} must be a valid URL.` };
    }
}

export function parseGitHubRepoInput(value: string): ParsedGitHubRepo | null {
    const normalizedUrl = normalizeHttpUrl(value, "Repository URL");
    if (!normalizedUrl.value) {
        return null;
    }

    try {
        const parsed = new URL(normalizedUrl.value);
        const host = parsed.hostname.toLowerCase();
        const normalizedHost = host.startsWith("www.") ? host.slice(4) : host;
        if (normalizedHost !== "github.com") {
            return null;
        }

        const parts = parsed.pathname
            .replace(/\.git$/i, "")
            .split("/")
            .map((segment) => segment.trim())
            .filter(Boolean);

        if (parts.length < 2) {
            return null;
        }

        const [owner, repo, marker, ...rest] = parts;
        let branch: string | null = null;

        if (marker === "tree" && rest.length > 0) {
            branch = rest.join("/");
        }

        return {
            owner,
            repo,
            fullName: `${owner}/${repo}`,
            repoUrl: `https://github.com/${owner}/${repo}`,
            branch,
        };
    } catch {
        return null;
    }
}
