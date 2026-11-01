---
title: 2. Sign in and create a project
sidebar_label: Sign in and create a project
---

# 2. Sign in and create a project

A project holds one application's tests, baselines and review history. Your
tests upload screenshots into a project, and the people who review them are
its members.

## You need

- Furan running ([1. Install Furan](install.md)).
- The admin login. On the one-file install it is `admin@furan.local` with the
  password `FuranAdmin123!`, unless you exported
  `FURAN_BOOTSTRAP_ADMIN_EMAIL` / `FURAN_BOOTSTRAP_ADMIN_PASSWORD`.

## Steps

1. Open `http://localhost:8080` and sign in with the admin login.
2. A fresh install has no projects, so you land on **Admin → Projects**.
   Click **Create project**.
3. Give it a **Name** (usually your application's name). **Main branch** is
   optional and defaults to `main`: it is the branch whose baselines other
   branches fall back to.
4. Click **Create**. You land on the new project's Builds page, which says
   there are no builds yet.

### Find the project ID

Your tests need the project's ID. It is the UUID in the address bar on the
project's pages:

```text
http://localhost:8080/projects/3f1c9a2e-…-…/builds
                               └──────── project ID ────────┘
```

Copy it now; the next steps call it `FURAN_PROJECT_ID`.

### Add your team (optional)

1. **Admin → Members → Create user.** Enter their email, a temporary password
   and their name, and pick the role **Editor** for people who review results.
   Share the temporary password with them.
2. **Admin → Projects**, open the project, then **Add member** with their
   email.

Editors see only the projects they are members of; admins see every project.

## You should see

The project's Builds page with an empty list: "No builds yet".

## If it doesn't work

- **"Invalid email or password":** on the one-file install, check whether you
  exported `FURAN_BOOTSTRAP_ADMIN_PASSWORD` before the first `up`. The admin
  is created once, on first boot; changing the variable later does not change
  the password.
- **"A project with this name already exists":** project names are unique.
  Pick another name.

---

**Previous:** [1. Install Furan](install.md) · **Next:** [3. Create a token](create-token.md)
