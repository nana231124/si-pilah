SI-PILAH LOCAL ANNOTATOR - BANTUAN USULAN YOLO

Isi paket:
- review_annotations.py
- review.html
- README.txt

Pemasangan:
1. Hentikan server reviewer lama dengan Ctrl+C.
2. Ekstrak ZIP ini.
3. Salin ketiga file ke folder 07_APLIKASI_SI_PILAH (folder yang sama dengan backend, frontend, dan runs). Pilih Replace untuk review_annotations.py dan review.html.
4. Pastikan file model tersedia di backend/best.pt.
5. Pastikan daftar_prioritas_lengkap.csv tersedia di runs/daftar_prioritas_lengkap.csv.
6. Pastikan package ultralytics sudah terpasang pada .venv.
7. Jalankan: python review_annotations.py
8. Buka http://127.0.0.1:8765 lalu Ctrl+F5.

Cara memakai usulan AI:
- Klik "Buat usulan AI". Reviewer memakai backend/best.pt untuk membuat kotak sementara di CPU.
- Garis kuning putus-putus adalah USULAN model, bukan anotasi benar.
- Bandingkan dengan foto dan kotak lama. Model bisa melewatkan objek atau membuat deteksi keliru, apalagi model dilatih dari anotasi yang sedang diaudit.
- Klik "Terapkan usulan AI" hanya jika semua kotak usulan sesuai; tindakan ini mengganti semua kotak gambar yang sedang dibuka di memori.
- Periksa lagi, lalu klik "Simpan perubahan" untuk menulis label pada dataset_sipilah_revisi. Backup .bak tetap dibuat sebelum perubahan pertama.
- Jika usulan tidak bagus, klik "Hapus usulan AI". Jangan menerapkan usulan kosong hanya karena model tidak mendeteksi apa pun.
- Jangan gunakan auto-suggestion sebagai bukti bahwa gambar sudah benar. Semua usulan tetap harus diperiksa manusia.

Keamanan:
- Tool hanya menyimpan ke 01_DATASET/dataset_sipilah_revisi.
- Dataset asli tidak diubah.
- Test sebaiknya hanya ditinjau; jangan gunakan prediksi atau anotasi test untuk memperbaiki training.
- Usulan AI berjalan lokal di CPU dan tidak mengirim gambar ke internet.
