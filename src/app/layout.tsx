import type { Metadata } from 'next';
import { I18nProvider } from '@/lib/i18n';
import { ConfirmHost } from '@/components/ui/confirm-dialog';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'MySkills',
  description: 'AI Skill Hub — unified management of AI agent skills',
};

// Note on fonts: we cannot use `next/font` here because it rejects the
// relative `assetPrefix: './'` set in next.config.mjs (which is required for
// Desktop static bundle loading). Falling back to system fonts — SF Pro Text on
// macOS gives us a close-to-Inter look without bundling font files. If we
// later need exact-Inter rendering, the next step is to download .woff2 files
// into public/fonts/ and declare @font-face rules in globals.css (sidestepping
// next/font and the assetPrefix conflict entirely).

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `lang` is updated client-side by I18nProvider when the user toggles.
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="h-screen overflow-hidden bg-background text-foreground antialiased">
        <I18nProvider>
          {children}
          <ConfirmHost />
        </I18nProvider>
      </body>
    </html>
  );
}
