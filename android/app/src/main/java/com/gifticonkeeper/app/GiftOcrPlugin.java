package com.gifticonkeeper.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "GiftOcr")
public class GiftOcrPlugin extends Plugin {
    private static final int MAX_IMAGE_BYTES = 6 * 1024 * 1024;
    private static final int MAX_BITMAP_DIMENSION = 1600;
    private final ExecutorService imageExecutor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void recognize(PluginCall call) {
        String dataUrl = call.getString("dataUrl");
        if (dataUrl == null || dataUrl.isEmpty()) {
            call.reject("이미지 데이터가 필요해요.");
            return;
        }

        imageExecutor.execute(() -> recognizeInBackground(call, dataUrl));
    }

    private void recognizeInBackground(PluginCall call, String dataUrl) {
        try {
            int comma = dataUrl.indexOf(',');
            String encoded = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            if (bytes.length == 0 || bytes.length > MAX_IMAGE_BYTES) {
                call.reject("이미지가 너무 크거나 비어 있어요.");
                return;
            }

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            int sampleSize = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / sampleSize > MAX_BITMAP_DIMENSION) {
                sampleSize *= 2;
            }

            BitmapFactory.Options decode = new BitmapFactory.Options();
            decode.inSampleSize = sampleSize;
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, decode);
            if (bitmap == null) {
                call.reject("이미지를 읽을 수 없어요.");
                return;
            }

            InputImage image = InputImage.fromBitmap(bitmap, 0);
            TextRecognizer recognizer = TextRecognition.getClient(new KoreanTextRecognizerOptions.Builder().build());
            recognizer.process(image)
                .addOnSuccessListener(result -> {
                    JSObject response = new JSObject();
                    response.put("text", result.getText());
                    call.resolve(response);
                })
                .addOnFailureListener(error -> {
                    String reason = error.getMessage();
                    if (reason != null && reason.contains("optional module")) {
                        call.reject(
                            "OCR 모델을 준비 중이에요. 인터넷에 연결한 상태에서 잠시 후 다시 시도해 주세요.",
                            "OCR_MODEL_DOWNLOADING",
                            error
                        );
                        return;
                    }
                    call.reject("사진에서 글자를 읽지 못했어요.", error);
                })
                .addOnCompleteListener(task -> {
                    recognizer.close();
                    bitmap.recycle();
                });
        } catch (OutOfMemoryError error) {
            call.reject("사진이 너무 커서 자동으로 읽을 수 없어요. 더 작은 이미지로 다시 시도해 주세요.", new Exception(error));
        } catch (IllegalArgumentException error) {
            call.reject("지원하지 않는 이미지 형식이에요.", error);
        } catch (Exception error) {
            call.reject("OCR 처리 중 오류가 발생했어요.", error);
        }
    }

    @Override
    protected void handleOnDestroy() {
        imageExecutor.shutdownNow();
    }
}
