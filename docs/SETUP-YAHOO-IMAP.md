# Connect Yahoo, AOL, iCloud or another IMAP mailbox

Yahoo only allows OAuth access to mail for developers who have signed a commercial agreement with Yahoo, which
isn't practical for a self-hosted project. Ghost-Hub connects over **IMAP with an app password** instead. Your
normal password is never needed, and you can delete the app password at any time to cut off access.

## Yahoo Mail

1. Turn on **two-step verification** for your Yahoo account (Yahoo requires it before it offers app passwords).
2. Open [Yahoo Account Security](https://login.yahoo.com/account/security), choose **Generate app password**,
   name it "Ghost-Hub" and copy the 16-character password.
3. In Ghost-Hub, open **Connect Yahoo, AOL, iCloud or another IMAP mailbox**, choose **Yahoo Mail**, enter your
   full Yahoo address and the app password, and click **Connect**.

Ghost-Hub checks the login before saving anything. The app password is stored encrypted (AES-256-GCM) and is
only ever decrypted to log in to your mailbox.

## AOL, iCloud and others

The same form works for **AOL Mail** (`imap.aol.com`) and **iCloud Mail** (`imap.mail.me.com`) with an app
password from their security pages. For any other provider choose **Other IMAP server** and enter its IMAP
hostname (for example Fastmail's `imap.fastmail.com`).

- Only **implicit TLS** (port 993 by default) is supported. Plaintext and STARTTLS are not.
- Use the provider's **app password** where it offers one. Many providers (Gmail, Outlook.com) no longer allow
  password logins over IMAP: use **Connect Gmail** / **Connect Outlook** for those.

## Disconnecting

**Disconnect** removes the stored password from Ghost-Hub. To make sure the credential can't be used again, also
delete the "Ghost-Hub" app password in your provider's security settings.
