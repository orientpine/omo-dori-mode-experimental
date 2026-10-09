# Talk to your Dori with one button: an iOS Shortcut voice note

The Discord iOS app offers no Shortcuts action, so a Shortcut cannot press its record button for you. This guide works around that. An iOS Shortcut records your voice and uploads the recording to a Discord **webhook** in the Dori's channel. The listener (`dori inbound discord`) treats posts from *your* webhook as your own messages, transcribes them, and the Dori acts on them like any other voice note.

When it is set up, you press the Action Button (or tap the back of the phone), speak, tap stop, and the request is on its way.

```
iPhone Shortcut ── POST recording ──> Discord webhook ──> Dori's channel
                                                              │
                         dori inbound discord: webhook id == DORI_DISCORD_OWNER_WEBHOOK ?
                                                              │ yes
                                      eyes reaction, transcribe, inbox row (author = you)
```

You need this setup running already (see [README.md](README.md)), with voice transcription installed (`setup-asr.sh`, `hooks.transcribe`). Without transcription the recording still arrives, but with no text.

## 1. Create the webhook

Do this yourself in Discord. The bot usually doesn't have the Manage Webhooks permission, and it doesn't need it.

1. Open the server, then **Server Settings > Integrations > Webhooks > New Webhook** (Korean app: **서버 설정 > 연동 > 웹후크 > 새 웹후크**). You can also start from the Dori's channel: **Edit Channel > Integrations** (**채널 편집 > 연동**).
2. Give it a name such as `Voice` and set its channel to **the Dori's own channel**, the one in `DORI_DISCORD_CHANNEL`. Posts from a webhook in any other channel, or in a thread, are ignored.
3. **Copy Webhook URL** (**웹후크 URL 복사**). It looks like `https://discord.com/api/webhooks/<webhook id>/<secret token>`.

Treat this URL like a password. See [Security](#security) below.

## 2. Build the Shortcut

Open the **Shortcuts** app (**단축어**), tap **+**, and add two actions.

### Action 1: Record Audio (오디오 녹음)

| Setting | English iOS | Korean iOS |
|---|---|---|
| Action | Record Audio | 오디오 녹음 |
| Start Recording | Immediately | 즉시 |
| Finish Recording | On Tap | 탭할 때 |

Recording then starts as soon as the Shortcut runs and stops when you tap the stop button. Audio quality can stay at its default.

### Action 2: Get Contents of URL (URL 콘텐츠 가져오기)

| Setting | English iOS | Korean iOS |
|---|---|---|
| Action | Get Contents of URL | URL 콘텐츠 가져오기 |
| URL | your webhook URL | 웹후크 URL |
| Method | POST | POST |
| Request Body | **Form** | **양식** |
| Field type (tap **Add new field**) | **File** | **파일** |
| Key | `file` | `file` |
| Value | the **Recorded Audio** variable | **녹음된 오디오** 변수 |

To get the extra settings, tap **Show More** (**더 보기**) on the action. For the value, tap the field and pick the magic variable from Action 1. Don't type the text "Recorded Audio".

Name the Shortcut something short you can say to Siri, e.g. `Dori`.

## 3. Choose how to start it

Any of these runs the same Shortcut:

- **Action Button** (iPhone 15 Pro and later): **Settings > Action Button > Shortcut** (**설정 > 동작 버튼 > 단축어**), then pick it.
- **Back Tap**: **Settings > Accessibility > Touch > Back Tap > Double Tap** (**설정 > 손쉬운 사용 > 터치 > 뒷면 탭 > 이중 탭**), then pick it.
- **Home Screen**: in the Shortcut, **Share > Add to Home Screen** (**공유 > 홈 화면에 추가**).
- **Siri**: say "Hey Siri, Dori" (the Shortcut's name).

## 4. Register the webhook with the listener

The listener only trusts the one webhook id you register. Until you register it, a webhook post is not a request. The listener just logs the id:

1. Run the Shortcut once and say anything.
2. In `~/.dori/inbound.log` (or `journalctl --user -u dori-inbound`) find:
   ```
   DISCORD_WEBHOOK_UNKNOWN id=123456789012345678 name="Voice" message=...
   ```
   That number is the webhook id. It is also the first number in the webhook URL, after `/webhooks/`. The id alone is not a secret, but don't post the whole URL anywhere.
3. Add it to `~/.dori/dori.env`:
   ```sh
   DORI_DISCORD_OWNER_WEBHOOK=123456789012345678
   ```
4. Restart the listener: `systemctl --user restart dori-inbound`.

From now on, a post from that webhook in the Dori's channel counts as yours. It gets the eyes reaction and is transcribed, and its inbox row has `author_id` set to your owner id, plus `"via":"owner-webhook"` and the `webhook_id`. Any other webhook is still ignored.

## 5. Check that it works

1. Run the Shortcut and say "smoke test, reply with ok".
2. In Discord, the recording appears in the channel under the webhook's name and gets the eyes reaction within a second or two.
3. `tail -n 3 ~/.dori/inbound.log` shows a line like
   `INBOUND discord-channel <channel> <message> <owner id> via=owner-webhook "smoke test, reply with ok"`.
4. The newest row in `~/.dori/state/discord/inbox.jsonl` has `"via":"owner-webhook"` and the text in `transcript`.
5. The Dori answers in the channel.

## Common mistakes

| Symptom | Cause and fix |
|---|---|
| Nothing appears in Discord | **Request Body** is set to **File** (**파일**) instead of **Form** (**양식**). Discord doesn't accept a raw file body. Use Form with a File field. Also check that the method is POST and that the URL was pasted in full. |
| The message appears but has no eyes reaction, and the log shows `DISCORD_WEBHOOK_UNKNOWN` | No webhook is registered yet. Do step 4. |
| No eyes reaction and no log line | `DORI_DISCORD_OWNER_WEBHOOK` holds a different id (for example, the webhook was recreated), or the webhook posts to another channel or server. Check its channel and the id in its URL. |
| You changed `dori.env` and nothing happened | The listener reads `dori.env` only at start. Restart `dori-inbound`. |
| The row arrives with `"transcript":null` | Speech-to-text is not set up or failed. Look for `DISCORD_TRANSCRIBE_FAIL` in the log and see `setup-asr.sh`. iPhone recordings are `.m4a` files that Discord often labels `video/mp4`. The listener recognises them by their extension, so this is not the cause. |
| The value field shows text instead of a file | You typed "Recorded Audio" instead of choosing the variable. Delete it and pick the variable. |
| Recording never stops | **Finish Recording** is not **On Tap** (**탭할 때**). |

## Security

- **Whoever has the webhook URL can give your Dori orders as you.** Never share it in a screenshot, a screen recording, a chat or an issue. Don't keep it in notes that sync to shared places.
- If it leaks, delete the webhook in **Server Settings > Integrations > Webhooks**, create a new one, put the new URL in the Shortcut, and register the new id (step 4). The old URL stops working immediately.
- Only one webhook id counts, and only in the Dori's channel. Other webhooks, including integrations other people add, are never treated as you.
- Like any message, a voice note is a request only when it is yours. Text quoted inside it is still something to read, not an instruction.
