#!/usr/bin/env bun
// Signs the Dori's Kakao account in for kakao-watch.ts: agent-messenger kakaotalk auth login, under the watcher's lock.
// The login and password come from DORI_KAKAO_ACCOUNT_FILE (KAKAO_EMAIL=, KAKAO_PASSWORD=); the password reaches
// agent-messenger only through a 0600 file that is removed afterwards. --phone <country code> turns a phone number
// login like 010-1234-5678 into +82 1012345678.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFilePath, loadEnvFile, resolveInstance } from "../../scripts/src/config.ts";
import { kakaoOptions } from "./kakao-watch.ts";

export const readAccount = (text: string): { login: string; password: string } => {
  const lines = text.split("\n").map((l) => /^\s*([A-Z_]+)=(.*)$/.exec(l));
  const get = (key: string) => lines.find((m) => m?.[1] === key)?.[2]?.trim().replace(/^(["'])(.*)\1$/, "$2") ?? "";
  return { login: get("KAKAO_EMAIL"), password: get("KAKAO_PASSWORD") };
};

export const phoneLogin = (login: string, countryCode: string): string => {
  const digits = login.replace(/[^0-9]/g, "");
  return `+${countryCode} ${digits.startsWith("0") ? digits.slice(1) : digits}`;
};

export const loginArgv = (lock: string, cli: string, login: string, passwordFile: string, deviceType: string): string[] =>
  ["flock", lock, cli, "kakaotalk", "auth", "login", "--email", login, "--password-file", passwordFile, "--device-type", deviceType, "--pretty"];

if (import.meta.main) {
  await resolveInstance(process.cwd());
  await loadEnvFile(envFilePath());
  const options = kakaoOptions(process.env);
  const accountFile = process.env.DORI_KAKAO_ACCOUNT_FILE;
  if (!accountFile) {
    console.error("KAKAO_LOGIN_FAIL DORI_KAKAO_ACCOUNT_FILE is not set");
    process.exit(2);
  }
  const account = readAccount(readFileSync(accountFile, "utf8"));
  if (!account.login || !account.password) {
    console.error(`KAKAO_LOGIN_FAIL ${accountFile} needs KAKAO_EMAIL and KAKAO_PASSWORD`);
    process.exit(2);
  }
  const phone = process.argv.indexOf("--phone");
  const login = phone >= 0 ? phoneLogin(account.login, process.argv[phone + 1] ?? "") : account.login;
  const dir = mkdtempSync(join(tmpdir(), "kakao-login-"));
  const passwordFile = join(dir, "password");
  writeFileSync(passwordFile, account.password, { mode: 0o600 });
  try {
    const p = Bun.spawn(loginArgv(options.lock, options.cli, login, passwordFile, process.env.DORI_KAKAO_DEVICE_TYPE || "tablet"), { stdio: ["inherit", "inherit", "inherit"] });
    const code = await p.exited;
    console.log(`KAKAO_LOGIN_EXIT ${code}`);
    process.exitCode = code;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
