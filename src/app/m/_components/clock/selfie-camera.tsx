"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { workerMessages } from "@/lib/messages/worker";
import { compressSelfie, compressSelfieFile } from "@/lib/punches/photo";

const copy = workerMessages.clock;

/**
 * The selfie step (WkClock board): the front camera with the oval guide, "Capture and clock in",
 * and the phone's camera app as the fallback (`<input type=file capture=user>`) when the camera
 * can't open in the page. The photo is made small on the phone before it is queued.
 */
export function SelfieCamera({
  busy,
  onPhoto,
  onSkip,
}: {
  busy: boolean;
  onPhoto: (photo: Blob) => void;
  onSkip: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    async function open() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("No camera");
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 640 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setReady(true);
      } catch {
        if (!cancelled) setCameraFailed(true);
      }
    }
    void open();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setCameraFailed(true);
      return;
    }
    const photo = await compressSelfie(video, video.videoWidth, video.videoHeight);
    if (!photo) {
      setProblem(copy.photoFailed);
      return;
    }
    onPhoto(photo);
  }

  async function fromFile(file: File | undefined) {
    if (!file) return;
    const photo = await compressSelfieFile(file);
    if (!photo) {
      setProblem(copy.photoFailed);
      return;
    }
    onPhoto(photo);
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div
        role="img"
        aria-label={copy.cameraLabel}
        className="relative flex h-[380px] items-center justify-center overflow-hidden rounded-xl bg-black"
      >
        {cameraFailed ? null : (
          <video
            ref={videoRef}
            muted
            playsInline
            data-testid="selfie-video"
            className="absolute inset-0 size-full -scale-x-100 object-cover"
          />
        )}
        <span
          aria-hidden
          className="relative h-[260px] w-[200px] rounded-full border-[3px] border-white"
        />
      </div>
      <p className="m-0 text-center text-[15px] text-fg-muted">{copy.selfieHint}</p>
      {cameraFailed ? (
        <p role="status" className="m-0 text-center text-[15px]">
          {copy.cameraFailed}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="m-0 text-center text-[15px]">
          {problem}
        </p>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="user"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="selfie-file"
        onChange={(event) => void fromFile(event.target.files?.[0])}
      />
      <div className="mt-auto flex flex-col gap-2.5">
        {cameraFailed ? (
          <Button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="h-[60px] w-full rounded-xl font-display text-xl font-bold"
          >
            {copy.usePhoto}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={busy || !ready}
            onClick={() => void capture()}
            className="h-[60px] w-full rounded-xl font-display text-xl font-bold"
          >
            {busy ? copy.saving : copy.capture}
          </Button>
        )}
        {cameraFailed ? null : (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="h-[52px] w-full rounded-xl text-base"
          >
            {copy.usePhoto}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onSkip}
          className="h-11 w-full text-[15px] text-fg-muted"
        >
          {copy.skipSelfie}
        </Button>
      </div>
    </div>
  );
}
