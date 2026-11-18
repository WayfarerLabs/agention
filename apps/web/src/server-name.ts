// The server's name, which the server writes into the page's metadata as it
// serves the page, so an operator running several servers tells them apart:
// the brand in the banner, the end of each page's title, and the passkeys
// that belong to it. A page without the name, as the component tests render,
// names Agention.
export function serverName(): string {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="application-name"]')?.content ?? "Agention"
  );
}
