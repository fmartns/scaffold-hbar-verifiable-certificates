import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import jsQR from "jsqr";
import { QrScanner } from "./QrScanner";

vi.mock("jsqr", () => ({ default: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();

  delete (navigator as any).mediaDevices;
});

function installCamera(stream: unknown = { getTracks: () => [{ stop: vi.fn() }] }) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
    configurable: true,
    get: () => 4, // HAVE_ENOUGH_DATA
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  } as any);
}

describe("QrScanner", () => {
  it("offers manual entry when the browser has no camera API", async () => {
    render(<QrScanner onScanned={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan QR code" }));
    expect(await screen.findByText(/cannot access the camera/)).toBeTruthy();
  });

  it("asks the visitor to enter the id manually when permission is denied", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      },
    });
    render(<QrScanner onScanned={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan QR code" }));
    expect(await screen.findByText(/Camera access was denied/)).toBeTruthy();
  });

  it("reports the camera as unavailable on any other startup failure", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error("no device")) },
    });
    render(<QrScanner onScanned={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan QR code" }));
    expect(await screen.findByText(/could not be started/)).toBeTruthy();
  });

  it("starts the camera, scans a frame, and reports the decoded value exactly once", async () => {
    installCamera();
    vi.mocked(jsQR).mockReturnValue({ data: "0xdeadbeef", location: {} } as never);
    const onScanned = vi.fn();
    render(<QrScanner onScanned={onScanned} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan QR code" }));
    await waitFor(() => expect(onScanned).toHaveBeenCalledWith("0xdeadbeef"));
    expect(onScanned).toHaveBeenCalledTimes(1);
  });

  it("lets the visitor stop scanning before anything is decoded", async () => {
    installCamera();
    vi.mocked(jsQR).mockReturnValue(null);
    render(<QrScanner onScanned={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan QR code" }));
    const stop = await screen.findByRole("button", { name: "Stop scanning" });
    fireEvent.click(stop);
    expect(await screen.findByRole("button", { name: "Scan QR code" })).toBeTruthy();
  });
});
