import React from "react";

/** Subscribe to viewport or input changes without remounting the pane. */
export function useMediaQuery(query) {
    const read = () => (typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(query).matches
        : false);
    const [matches, setMatches] = React.useState(read);
    React.useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
        const media = window.matchMedia(query);
        const onChange = (event) => setMatches(event.matches);
        setMatches(media.matches);
        media.addEventListener?.("change", onChange);
        return () => media.removeEventListener?.("change", onChange);
    }, [query]);
    return matches;
}

/** Phones: at most 600 px wide (the portal's phone layout). */
export const PHONE_MEDIA_QUERY = "(max-width: 600px)";
