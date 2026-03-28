import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Attachment {
  id: number;
  filename: string;
  mime_type: string;
  size: number;
  flagged: boolean;
}

interface AttachmentViewerProps {
  attachment: Attachment;
  onClose: () => void;
  onFlagToggle: (attachmentId: number, flagged: boolean) => void;
}

function AttachmentViewer({ attachment, onClose, onFlagToggle }: AttachmentViewerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string>("");
  const [imageZoom, setImageZoom] = useState(100);

  useEffect(() => {
    loadAttachment();
  }, [attachment.id]);

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (isImage && !loading && !error) {
        if (e.key === "+" || e.key === "=") {
          handleZoomIn();
        } else if (e.key === "-" || e.key === "_") {
          handleZoomOut();
        } else if (e.key === "0") {
          handleZoomReset();
        }
      }
    };

    window.addEventListener("keydown", handleKeyPress);
    return () => window.removeEventListener("keydown", handleKeyPress);
  }, [isImage, loading, error, imageZoom]);

  const loadAttachment = async () => {
    try {
      setLoading(true);
      setError(null);
      console.log("Loading attachment:", attachment.id);
      
      const base64Data = await invoke<string>("get_attachment_data", {
        attachmentId: attachment.id,
      });
      
      // Create data URL
      const dataUrl = `data:${attachment.mime_type};base64,${base64Data}`;
      setDataUrl(dataUrl);
    } catch (error) {
      console.error("Failed to load attachment:", error);
      setError("Failed to load attachment: " + String(error));
    } finally {
      setLoading(false);
    }
  };

  const handleFlagToggle = async () => {
    await onFlagToggle(attachment.id, !attachment.flagged);
  };

  const handleDownload = () => {
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = attachment.filename;
    link.click();
  };

  const handleZoomIn = () => {
    setImageZoom((prev) => Math.min(prev + 25, 300));
  };

  const handleZoomOut = () => {
    setImageZoom((prev) => Math.max(prev - 25, 25));
  };

  const handleZoomReset = () => {
    setImageZoom(100);
  };

  const isImage = attachment.mime_type.startsWith("image/");
  const isPdf = attachment.mime_type === "application/pdf";
  const isText = attachment.mime_type.startsWith("text/");

  return (
    <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-surface rounded-xl border-2 border-aperture-cyan/50 shadow-aperture-lg max-w-6xl max-h-[90vh] w-full flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-dark-border bg-dark-card">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-white truncate">
              {attachment.filename}
            </h2>
            <p className="text-xs text-gray-400">
              {attachment.mime_type} • {(attachment.size / 1024).toFixed(1)} KB
            </p>
          </div>
          <div className="flex items-center gap-2 ml-4">
            {/* Zoom controls for images */}
            {isImage && !loading && !error && (
              <div className="flex items-center gap-1 mr-2 border-r border-dark-border pr-2">
                <button
                  onClick={handleZoomOut}
                  disabled={imageZoom <= 25}
                  className="px-3 py-2 rounded-lg text-sm font-medium bg-dark-surface text-gray-400 border-2 border-dark-border hover:border-aperture-cyan disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  title="Zoom Out"
                >
                  🔍−
                </button>
                <span className="text-sm text-gray-400 min-w-[3rem] text-center">
                  {imageZoom}%
                </span>
                <button
                  onClick={handleZoomIn}
                  disabled={imageZoom >= 300}
                  className="px-3 py-2 rounded-lg text-sm font-medium bg-dark-surface text-gray-400 border-2 border-dark-border hover:border-aperture-cyan disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  title="Zoom In"
                >
                  🔍+
                </button>
                <button
                  onClick={handleZoomReset}
                  className="px-3 py-2 rounded-lg text-sm font-medium bg-dark-surface text-gray-400 border-2 border-dark-border hover:border-aperture-cyan transition-all"
                  title="Reset Zoom"
                >
                  ↺
                </button>
              </div>
            )}
            <button
              onClick={handleDownload}
              disabled={loading || error !== null}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-dark-surface text-gray-400 border-2 border-dark-border hover:border-aperture-cyan disabled:opacity-50 transition-all"
            >
              💾 Download
            </button>
            <button
              onClick={handleFlagToggle}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                attachment.flagged
                  ? "bg-aperture-magenta/20 text-aperture-magenta border-2 border-aperture-magenta"
                  : "bg-dark-surface text-gray-400 border-2 border-dark-border hover:border-aperture-magenta"
              }`}
            >
              {attachment.flagged ? "🚩 Flagged" : "Flag as Evidence"}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-dark-surface text-gray-400 border-2 border-dark-border hover:border-red-500 hover:text-red-500 transition-all"
            >
              ✕ Close
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 bg-dark-bg">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-aperture-cyan text-lg animate-pulse">
                Loading attachment...
              </div>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-red-400">{error}</div>
            </div>
          ) : isImage ? (
            <div className="flex items-center justify-center h-full overflow-auto">
              <img
                src={dataUrl}
                alt={attachment.filename}
                style={{
                  width: `${imageZoom}%`,
                  maxWidth: imageZoom === 100 ? "100%" : "none",
                  height: imageZoom === 100 ? "auto" : "auto",
                  maxHeight: imageZoom === 100 ? "100%" : "none",
                }}
                className="object-contain rounded-lg border border-aperture-cyan/30 transition-all"
              />
            </div>
          ) : isPdf ? (
            <div className="w-full h-full flex flex-col">
              <div className="text-xs text-gray-400 mb-2 px-2">
                💡 Tip: Use your browser's PDF controls to zoom and navigate
              </div>
              <iframe
                src={dataUrl}
                className="w-full flex-1 rounded-lg border border-aperture-cyan/30"
                title={attachment.filename}
              />
            </div>
          ) : isText ? (
            <div className="h-full overflow-auto">
              <pre className="text-gray-300 text-sm p-4 bg-dark-surface rounded-lg border border-aperture-cyan/30 whitespace-pre-wrap break-words">
                {/* Text content would be loaded here */}
                {atob(dataUrl.split(',')[1] || '')}
              </pre>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="text-6xl mb-4">📄</div>
              <p className="text-gray-400 mb-2">
                Preview not available for this file type
              </p>
              <p className="text-sm text-gray-500 mb-4">
                {attachment.mime_type}
              </p>
              <button
                onClick={handleDownload}
                className="btn-primary"
              >
                💾 Download File
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AttachmentViewer;
