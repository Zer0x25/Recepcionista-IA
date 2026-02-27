export const HANDOFF_KEYWORDS = [
    "humano",
    "soporte",
    "persona",
    "agente",
    "hablar con alguien",
];
export function shouldHandoff(messageText) {
    const normalizedText = messageText.toLowerCase();
    return HANDOFF_KEYWORDS.some((keyword) => normalizedText.includes(keyword));
}
//# sourceMappingURL=handoff.js.map