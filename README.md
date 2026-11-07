# Kasir Rental PS3

Jalankan di Termux:
    node server.js
Buka http://localhost:3000 (atau IP HP dari perangkat lain di WiFi yang sama).

Ganti sebelum dipakai:
    WEBHOOK_SECRET=rahasiamu ADMIN_PIN=123456 node server.js

## MacroDroid (deteksi pembayaran otomatis)
Trigger : Notifikasi Diterima -> aplikasi DANA -> teks mengandung "Rp" (sesuaikan dengan teks notif uang masuk DANA)
Action  : HTTP Request
  Method POST
  URL  http://127.0.0.1:3000/api/webhook?secret=rahasiamu
  Body : isi notifikasi (magic text "Notification Text"), tipe text/plain
Kalau MacroDroid di HP lain, ganti 127.0.0.1 dengan IP HP server.

Harga default ada di PRESETS di server.js. Data tersimpan di data.json.
# kasir-rental-ps3

## Tabel Supabase wajib
Jalankan sekali di SQL editor Supabase (fitur kelola menu & harga):

create table if not exists kasir_presets (
  id bigint generated always as identity primary key,
  name text not null,
  price int not null,
  sort int not null default 0
);

Kalau tabel ini belum ada/kosong, daftar menu memakai DEFAULT_PRESETS di api/index.js.
Setelah diedit dari dashboard, harga di tab Kasir langsung berubah (tanpa deploy).

## Tabel tambahan (PIN env + anti brute force)
create table if not exists kasir_authfail (
  id bigint generated always as identity primary key,
  key text not null,
  at bigint not null
);
create index if not exists kasir_authfail_key_at on kasir_authfail (key, at desc);

## PIN dari environment (#56)
Set di Vercel -> Settings -> Environment Variables:
  PIN=pinbaru         (default 1111 kalau kosong)
  WEBHOOK_SECRET=...  (dipakai MacroDroid, default nilai lama)

PIN salah 5x dalam 15 menit -> endpoint diblokir 15 menit (#58).
Frontend menampilkan sisa percobaan dari pesan error API.

## Uang kembalian (#16)
Tombol "Bayar cash" membuka input uang diterima, menampilkan kembalian,
dan menyimpan `paid` + `change` ke transaksi (kolom baru, opsional):
  alter table kasir_trx add column if not exists paid int;
  alter table kasir_trx add column if not exists change int;
