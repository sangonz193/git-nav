import { describe, expect, test } from "bun:test"

import {
  defaultSharingSettings,
  displayedSharingSettings,
  sharingPort,
  sharingPublicUrl,
  sharingSettings,
} from "./sharing-state"

describe("sharing settings", () => {
  test("uses safe defaults when no values are stored", () => {
    expect(sharingSettings({})).toEqual(defaultSharingSettings)
  })

  test("surfaces an invalid stored port", () => {
    expect(() =>
      sharingSettings({ "serve.host": "localhost", "serve.port": 80 })
    ).toThrow("The saved port must be a number between 1024 and 65535.")
  })

  test("reads the stored network sharing configuration", () => {
    expect(
      sharingSettings({
        "serve.host": "0.0.0.0",
        "serve.port": 4310,
        "serve.publicUrl": "https://git-nav.example/path",
        "serve.startSharing": true,
      })
    ).toEqual({
      host: "0.0.0.0",
      port: 4310,
      publicUrl: "https://git-nav.example/path",
      startSharing: true,
    })
  })
})

describe("sharing port", () => {
  test("accepts the unprivileged port range", () => {
    expect(sharingPort(1024)).toBe(1024)
    expect(sharingPort(4300)).toBe(4300)
    expect(sharingPort(65535)).toBe(65535)
  })

  test("rejects anything that is not an in-range integer", () => {
    expect(sharingPort(1023)).toBeNull()
    expect(sharingPort(65536)).toBeNull()
    expect(sharingPort(4300.5)).toBeNull()
    expect(sharingPort(Number.NaN)).toBeNull()
    expect(sharingPort("4300")).toBeNull()
    expect(sharingPort(undefined)).toBeNull()
  })
})

describe("displayed sharing settings", () => {
  const stored = {
    host: "127.0.0.1",
    port: 4300,
    publicUrl: "",
    startSharing: false,
  } as const

  const sharingOn = (host: string | null, port: number | null) => ({
    entryUrls: [],
    host,
    port,
    sharing: true,
  })

  test("shows the stored settings when sharing is off", () => {
    expect(
      displayedSharingSettings(stored, {
        entryUrls: [],
        host: null,
        port: null,
        sharing: false,
      })
    ).toEqual(stored)
    expect(displayedSharingSettings(stored, null)).toEqual(stored)
  })

  test("shows the running host and port while sharing", () => {
    expect(
      displayedSharingSettings(stored, sharingOn("0.0.0.0", 4310))
    ).toEqual({ ...stored, host: "0.0.0.0", port: 4310 })
  })

  test("reports an address other than the loopback ones as reachable", () => {
    expect(
      displayedSharingSettings(stored, sharingOn("192.168.1.5", 4300)).host
    ).toBe("0.0.0.0")
    expect(displayedSharingSettings(stored, sharingOn("::1", 4300)).host).toBe(
      "127.0.0.1"
    )
  })

  test("falls back to the stored settings without a running address", () => {
    expect(displayedSharingSettings(stored, sharingOn(null, null))).toEqual(
      stored
    )
  })
})

describe("sharing public URL", () => {
  test("accepts http and https addresses and an empty value", () => {
    expect(sharingPublicUrl("https://git-nav.example")).toBe(
      "https://git-nav.example"
    )
    expect(sharingPublicUrl("http://git-nav.example:8080/path")).toBe(
      "http://git-nav.example:8080/path"
    )
    expect(sharingPublicUrl("")).toBe("")
  })

  test("rejects malformed addresses and other schemes", () => {
    expect(sharingPublicUrl("git-nav.example")).toBeNull()
    expect(sharingPublicUrl("ftp://git-nav.example")).toBeNull()
    expect(sharingPublicUrl("javascript:alert(1)")).toBeNull()
    expect(sharingPublicUrl("https://")).toBeNull()
  })
})
