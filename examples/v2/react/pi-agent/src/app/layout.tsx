import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Pi Agent · CopilotKit",
  description:
    "Pi Agent with CopilotKit: tools, shared state, and human confirmation.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
