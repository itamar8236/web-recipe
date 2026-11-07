import '@/styles/globals.css';
import Shell from '@/components/Shell';
import RegisterServiceWorker from '@/components/RegisterServiceWorker';

export const metadata = {
  title: 'My Recipes',
  description: 'A simple place to keep recipes in English and Hebrew.',
  icons: { apple: '/icons/apple-touch-icon.png' },
};

export const viewport = { themeColor: '#c4501b' };

export default function RootLayout({ children }) {
  // Hebrew is the starting language; the client switches lang/dir when the user toggles.
  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <body>
        <RegisterServiceWorker />
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
