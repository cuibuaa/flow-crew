import typography from "@tailwindcss/typography";
declare const _default: {
    content: string[];
    theme: {
        extend: {
            screens: {
                "lg-wide": string;
            };
            fontFamily: {
                sans: [string, string, string];
                mono: [string, string, string, string];
            };
            colors: {
                rc: {
                    bg: string;
                    card: string;
                    hover: string;
                    border: string;
                    "border-hover": string;
                    text: string;
                    "text-secondary": string;
                    muted: string;
                    accent: string;
                    success: string;
                    error: string;
                    warning: string;
                    code: string;
                };
            };
            borderRadius: {
                card: string;
                btn: string;
                input: string;
            };
            boxShadow: {
                glow: string;
            };
        };
    };
    plugins: (typeof typography)[];
};
export default _default;
//# sourceMappingURL=tailwind.config.d.ts.map