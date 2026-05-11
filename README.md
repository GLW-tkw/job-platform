# Job Platform

A full-stack job management platform with Admin/User roles, real-time chat, and file uploads.

## Features

- **Two account types** — Admin and User
- **Admin** can create user accounts, post/edit jobs, mark jobs complete with comments
- **Users** can accept and submit assigned jobs
- **Job posts** include title, description, file attachments (with image preview), deadline/time limit, and responsible people
- **Status tracking** — Pending → Accepted → Submitted → Complete ("Complete In Time" or "Over Due X minutes")
- **Edited badge** shown after admin edits a post, with edit timestamp
- **Notifications** — users are notified when a job is assigned to them
- **Real-time Chat** — general chat room + per-job channels; users can reference a job in a message
- **Responsive design** — desktop sidebar layout + mobile bottom navigation

## Default Accounts

| Role  | Username | Password |
|-------|----------|----------|
| Admin | admin    | admin    |
| User  | user001  | user001  |

## Local Development

```bash
npm install
npm start
# Open http://localhost:3000
```

## Deploy to Render.com

1. Push this repository to GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repo
4. Render will auto-detect the `render.yaml` config
5. Click **Deploy**

> **Note:** The `render.yaml` includes a persistent **Disk** (1 GB, ~$0.25/month) to keep the database and uploads between deploys. On the free plan without a disk, data resets on each redeploy. Remove the `disk:` section for a pure free demo.

## Time Limit Options

When creating a job:
- **Specific deadline** — exact date & time
- **Duration from acceptance** — e.g. 2 hours after a user accepts
- **Before a time** — e.g. before 16:00 today
- **Time range** — e.g. 13:00 – 14:00 today