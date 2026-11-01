---
title: 3. Create a token
sidebar_label: Create a token
---

# 3. Create a token

Your tests authenticate with a personal access token, a `furan_pat_…` value
sent as a `Bearer` token. It acts as the account that created it.

## You need

- A Furan account with access to the project from
  [step 2](create-project.md).

## Steps

Where you create it depends on your role. The dialog is the same.

- **Admins:** **Admin → API Keys → Generate new key**. (Admins who open
  `/account/tokens` land here too.)
- **Editors:** open **Personal access tokens** at `/account/tokens`, or press
  ⌘K / Ctrl+K and choose "API tokens", then click **Create token**.

Then:

1. Enter a **Label** that says where the token will be used, for example
   `CI - main`, and click **Create**.
2. Click **Copy**. The token is shown **once**: Furan stores only its hash, so
   nobody can show it to you again.
3. Store it somewhere safe, typically your CI's secret store, as
   `FURAN_API_TOKEN`.
4. Tick "I've stored this token securely and understand it won't be shown
   again." and click **Close**.

A token works on the projects its account can access. It can't create
tokens or use admin features: those need a signed-in session.

## You should see

The token in the list, with its label and "Never" under **Last used**. After
your first upload, **Last used** updates.

## If it doesn't work

- **Lost the token:** delete it and create a new one. There is no way to
  recover it.
- **Uploads fail with 401:** the token was copied incompletely or was
  deleted. Create a new one.

---

**Previous:** [2. Sign in and create a project](create-project.md) · **Next:** [4. Send your first upload](first-upload.mdx)
