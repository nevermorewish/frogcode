---
name: google-workspace
description: Automate Google Workspace — Gmail, Drive, Sheets, Docs, Calendar via Google API Python client or gcloud CLI.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Google, Gmail, Drive, Sheets, Docs, Calendar, Workspace, Automation]
    related_skills: []
---

# Google Workspace

Automate Gmail, Drive, Sheets, Docs, and Calendar via the Google API Python client.

## Setup

```bash
pip install google-api-python-client google-auth-httplib2 google-auth-oauthlib
```

Create credentials at console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0.

```python
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
import os, pickle

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/calendar",
]

def get_credentials():
    creds = None
    if os.path.exists("token.pickle"):
        with open("token.pickle", "rb") as f:
            creds = pickle.load(f)
    if not creds or not creds.valid:
        flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
        creds = flow.run_local_server(port=0)
        with open("token.pickle", "wb") as f:
            pickle.dump(creds, f)
    return creds
```

---

## Gmail

```python
service = build("gmail", "v1", credentials=get_credentials())

# List messages
msgs = service.users().messages().list(userId="me", q="is:unread", maxResults=10).execute()

# Read message
def read_email(msg_id):
    msg = service.users().messages().get(userId="me", id=msg_id, format="full").execute()
    headers = {h["name"]: h["value"] for h in msg["payload"]["headers"]}
    return {
        "subject": headers.get("Subject"),
        "from": headers.get("From"),
        "snippet": msg["snippet"]
    }

# Send email
import base64
from email.mime.text import MIMEText

def send_email(to, subject, body):
    msg = MIMEText(body)
    msg["to"] = to
    msg["subject"] = subject
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    service.users().messages().send(userId="me", body={"raw": raw}).execute()
```

---

## Google Drive

```python
drive = build("drive", "v3", credentials=get_credentials())

# List files
files = drive.files().list(
    q="mimeType='application/vnd.google-apps.spreadsheet'",
    fields="files(id, name, modifiedTime)"
).execute()

# Upload file
from googleapiclient.http import MediaFileUpload
media = MediaFileUpload("report.pdf", mimetype="application/pdf")
drive.files().create(
    body={"name": "report.pdf", "parents": ["FOLDER_ID"]},
    media_body=media
).execute()

# Download file
import io
from googleapiclient.http import MediaIoBaseDownload
request = drive.files().get_media(fileId="FILE_ID")
fh = io.BytesIO()
downloader = MediaIoBaseDownload(fh, request)
done = False
while not done:
    _, done = downloader.next_chunk()
```

---

## Google Sheets

```python
sheets = build("sheets", "v4", credentials=get_credentials())

SHEET_ID = "your-spreadsheet-id"

# Read range
result = sheets.spreadsheets().values().get(
    spreadsheetId=SHEET_ID, range="Sheet1!A1:D10"
).execute()
rows = result.get("values", [])

# Write range
sheets.spreadsheets().values().update(
    spreadsheetId=SHEET_ID,
    range="Sheet1!A1",
    valueInputOption="RAW",
    body={"values": [["Name", "Score"], ["Alice", 95], ["Bob", 87]]}
).execute()

# Append rows
sheets.spreadsheets().values().append(
    spreadsheetId=SHEET_ID,
    range="Sheet1!A:A",
    valueInputOption="RAW",
    body={"values": [["New Row", "Data"]]}
).execute()
```

---

## Google Calendar

```python
cal = build("calendar", "v3", credentials=get_credentials())

# List events
events = cal.events().list(
    calendarId="primary",
    maxResults=10,
    singleEvents=True,
    orderBy="startTime"
).execute()

for event in events.get("items", []):
    print(event["summary"], event["start"].get("dateTime"))

# Create event
cal.events().insert(
    calendarId="primary",
    body={
        "summary": "Team Meeting",
        "start": {"dateTime": "2026-04-08T10:00:00+09:00"},
        "end": {"dateTime": "2026-04-08T11:00:00+09:00"},
        "attendees": [{"email": "colleague@example.com"}],
    }
).execute()
```

---

## gcloud CLI Alternative

```bash
# Auth
gcloud auth login
gcloud auth application-default login

# Drive: list files
gdrive list

# Sheets: export as CSV
gsheet export SHEET_ID --format csv
```
