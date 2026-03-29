import cv2
from ultralytics import YOLO
import time
import sys

# Constants
REAL_WIDTH_METERS = 0.5
FOCAL_LENGTH = 600.0
PERSON_CLASS_ID = 0 

def estimate_distance(pixel_width: float) -> float:
    if pixel_width <= 0: return float("inf")
    return (REAL_WIDTH_METERS * FOCAL_LENGTH) / pixel_width

def main() -> None:
    print("--- Vision-Sync: Initializing AI ---", flush=True)
    model = YOLO("yolov8n.pt")
    
    print("--- Opening Camera /dev/video0 ---", flush=True)
    cap = cv2.VideoCapture(0) # In WSL, 0 usually maps to /dev/video0
    
    # Force the camera to use MJPEG format (much faster for WSL)
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc('M', 'J', 'P', 'G'))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    if not cap.isOpened():
        print("Error: Could not open camera. Is it attached in PowerShell?", flush=True)
        return

    print("--- System LIVE. Press 'q' to quit. ---", flush=True)

    try:
        while cap.isOpened():
            start_time = time.time()
            success, frame = cap.read()
            
            if not success:
                print("Error: Dropped frame from camera.", flush=True)
                break

            # AI Inference
            results = model.predict(frame, classes=[0], verbose=False)
            
            person_found = False
            for result in results:
                for box in result.boxes:
                    person_found = True
                    x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                    pixel_width = max(x2 - x1, 1)
                    distance_m = estimate_distance(pixel_width)

                    # Print immediately to terminal
                    print(f"DEBUG: Person detected at {distance_m:.2f}m", flush=True)

                    # Draw visuals
                    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                    cv2.putText(frame, f"{distance_m:.1f}m", (x1, y1 - 10), 
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

            # Performance monitor
            fps = 1.0 / (time.time() - start_time)
            cv2.putText(frame, f"FPS: {fps:.1f}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 0, 0), 2)

            # Show the window
            cv2.imshow("Vision-Sync Phase 1", frame)

            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
                
    except Exception as e:
        print(f"System Crash: {e}", flush=True)
    finally:
        cap.release()
        cv2.destroyAllWindows()
        print("System safely shut down.", flush=True)

if __name__ == "__main__":
    main()