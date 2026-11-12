# Admin access: sign-in, permissions and setup

The admin page doesn't use personal GitHub tokens any more. People **sign in with GitHub**, and every
save goes through the **admin API**, a small Cloudflare Worker in `worker/`. The API is the only thing
that can write to the repository: it checks each change against `content/access.json` and then commits
it as the site's **GitHub App**. Hiding tabs and buttons on the page is only a convenience; the rules
are enforced in the API (`src/shared/access.ts`, tested in `tests/admin-api.test.ts`).

## Permissions

| Permission | Lets someone |
|---|---|
| **Maps & slots** | open the Maps & slots tab: upload or replace map images, add slots, change slot settings |
| **Create regions** | draw new regions, and edit or delete the regions they created; also add region categories and rename, reorder or delete their own (see below) |
| **Edit others' regions** | change regions other people created, and rename or delete other people's categories |
| **Delete others' regions** | delete regions other people created |
| **Manage users** | open the Users tab and add or change people, but only with permissions they hold themselves, and never their own entry or the owner's |

The presets are shortcuts. **Contributor** gives Create regions. **Editor** gives Create regions and Edit others' regions. **Admin** gives everything. The repository owner (`OWNER_ID` in `worker/wrangler.toml`) can always do everything, whatever `access.json` says. Nobody else gets Maps & slots unless it's ticked for them.

Every region records who created it (`createdBy`), when (`created`) and who saved it last (`updatedBy`).
The API fills nothing in by itself. It checks those fields instead: a new region must name the person
saving it as its creator, and only the owner can change a region's creator. Regions from before this
change belong to the owner until `npm run region-owners` gives them the account that first committed them.

## Region categories

The Regions tab can group regions into collapsible folders (**New category…**). Folders are saved in
`content/categories.json` (checked against `schema/categories.schema.json`): an ordered list of
`{ id, name, regions: [region ids], createdBy, created }`. A region is in at most one category; regions in none
show under **Uncategorized**, and with no categories at all the list is flat as before. Categories are for the
admin page only: the public embed doesn't read them.

They follow the region rules, with no extra permission:

- **Create regions** adds categories (saved with the creator, like regions) and renames or deletes your own. Anyone with it can reorder folders (the order is cosmetic).
- **Edit others' regions** also renames and deletes other people's categories. Categories with no creator recorded belong to the owner.
- Moving a region into or out of a category (its **Category** menu) needs the right to edit that region: your own, or anyone's with Edit others' regions. Deleting a category doesn't delete its regions; they become uncategorized.
- Deleting a region leaves its id in `categories.json` until the next category change tidies it up (the build only warns about it).

The API checks all of this on save, like the other rules.

## Adding someone

1. **Users** tab → type their GitHub username → choose a preset → **Add person** → **Save changes**.
2. Send them the admin page link. They click **Sign in with GitHub**. That's all they need: a free GitHub account, no token, no repository invite.

If someone signs in before they're added, they're told they're waiting, and they appear under **Asked for access** in the Users tab, where you can approve them in one click. Removing someone takes effect on their next save, even while they're still signed in. Sessions last 12 hours and only live in that browser tab.

## One-time setup (repository owner)

You do this once. Until it's done, the Admin API workflow skips its deploy and the admin page says sign-in isn't set up.

### 1. Cloudflare

The admin API lives at `https://admin-api.garmeley.com` (set under `[[routes]]` in `worker/wrangler.toml`). `garmeley.com` must be a site in the same Cloudflare account; the first deploy creates the DNS record and certificate.

1. **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template. Under **Account Resources** pick your account; under **Zone Resources** pick *Specific zone → garmeley.com* (the template's *Workers Routes: Edit* is what attaches the address). Create it and copy the token.
2. Copy your **Account ID** (on the Workers & Pages overview, right-hand side).

(The KV namespace for the waiting list, `world-globe-admin-waiting`, already exists and is set in `worker/wrangler.toml`.)

### 2. GitHub App

**GitHub → Settings → Developer settings → GitHub Apps → New GitHub App:**

- **Name:** for example `World Globe Admin` (people see it on the sign-in screen).
- **Homepage URL:** `https://editor.garmeley.com/admin/`
- **Callback URL:** `https://admin-api.garmeley.com/auth/callback`
- Leave **Expire user authorization tokens** on. Leave **Request user authorization (OAuth) during installation** off.
- **Webhook:** untick **Active**.
- **Repository permissions:** Contents **Read and write**, Actions **Read-only** (Metadata read-only is added automatically). Nothing else, and no account permissions.
- **Where can this GitHub App be installed?** Only on this account.

Then, on the App's page:

1. Note the **App ID** and the **Client ID**.
2. **Generate a new client secret** and copy it.
3. **Generate a private key**. A `.pem` file downloads.
4. **Install App** → your account → **Only select repositories → world-globe-embed**.

### 3. Repository secrets and variables

**world-globe-embed → Settings → Secrets and variables → Actions.**

Secrets:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the Cloudflare token from step 1 |
| `APP_PRIVATE_KEY` | the whole contents of the `.pem` file |
| `APP_CLIENT_SECRET` | the App's client secret |
| `SESSION_KEY` | a long random string (at least 32 characters). Changing it later signs everyone out. |

Variables:

| Name | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account id |
| `APP_ID` | the App ID |
| `APP_CLIENT_ID` | the Client ID |
| `ADMIN_API_URL` | `https://admin-api.garmeley.com` |

### 4. Site address (editor.garmeley.com)

The whole site (viewer, embeds and admin page) is served at `editor.garmeley.com`. The build uses relative paths, so nothing in the code changes.

1. **Cloudflare → garmeley.com → DNS → Add record:** type `CNAME`, name `editor`, target `flanz1.github.io`, proxy status **DNS only** (grey cloud), so GitHub can issue the certificate.
2. **GitHub → your profile Settings → Pages → Add a domain:** `editor.garmeley.com`. Add the TXT record GitHub shows in Cloudflare DNS, then **Verify**. This stops anyone else's Pages site from claiming the name.
3. **world-globe-embed → Settings → Pages → Custom domain:** `editor.garmeley.com` → **Save**. Once the certificate is ready (a few minutes up to an hour), tick **Enforce HTTPS**.

Old `https://flanz1.github.io/world-globe-embed/...` links, including iframes already pasted into notes, are redirected by GitHub to the same path on `editor.garmeley.com`, so they keep working. Embed codes copied from the admin page from now on use the new address.

### 5. Deploy

**Actions → Admin API → Run workflow**, then **Actions → Deploy → Run workflow** (so the admin page is rebuilt with `ADMIN_API_URL`). Open the admin page and sign in.

### 6. Lock it down

Once you've signed in through the new page:

1. **Settings → Collaborators:** remove everyone except yourself. Contributors don't need write access any more; the repository is public, so they can still read and fork it.
2. **Settings → Rules → Rulesets:** protect `main` (require a pull request, block force pushes and deletion) with the GitHub App as the only bypass. The admin page and Process maps both push as the App, so they keep working.

## Running the API locally or in tests

`tests/admin-api.test.ts` runs the real handler in Node against the in-memory GitHub in `scripts/e2e/mock-github.mjs`, through the admin page's own client. The browser checks (`npm run e2e:*`) do the same inside Playwright. The schema validators the Worker uses are generated: after changing `schema/region.schema.json` or `schema/access.schema.json`, run `npm run worker:validators` (a test fails if you forget).
