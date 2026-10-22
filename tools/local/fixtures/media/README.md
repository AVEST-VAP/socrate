# Médias fictifs

Images unies bleues de 160 × 90 pixels. Vidéos de mire FFmpeg de 160 × 90 pixels, 12 images par seconde, une seconde, sans audio. Aucun enregistrement du poste ni contenu externe.

Fichiers produits avec le FFmpeg déjà installé. Les commandes suivantes écrivent uniquement dans le dossier courant, à exécuter dans ce dossier avec les variables temporaires locales du worktree.

```sh
ffmpeg -nostdin -f lavfi -i 'testsrc2=size=160x90:rate=12:duration=1' -c:v libvpx-vp9 -an parcours.webm
ffmpeg -nostdin -f lavfi -i 'testsrc2=size=160x90:rate=12:duration=1' -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an parcours.mp4
ffmpeg -nostdin -f lavfi -i 'color=c=0x3685d6:s=160x90:d=0.1' -frames:v 1 image.png
ffmpeg -nostdin -i image.png -frames:v 1 image.jpg
ffmpeg -nostdin -f lavfi -i 'testsrc2=size=160x90:rate=12:duration=1' -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=1' -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 64k -shortest ecran.mov
ffmpeg -nostdin -f lavfi -i 'testsrc2=size=160x90:rate=2:duration=600' -c:v libx264 -pix_fmt yuv420p -crf 45 -g 120 -an ecran-10min.mov
ffmpeg -nostdin -f lavfi -i 'color=c=0x3685d6:s=64x36:r=1:d=960' -c:v libx264 -pix_fmt yuv420p -an ecran-16min.mov
```

Vidéos longues : `ecran.mov` est un MOV QuickTime H.264/AAC d'une seconde, `ecran-10min.mov` une mire de dix minutes sans audio et `ecran-16min.mov` une image unie de seize minutes. Les tests gonflent `ecran-10min.mov` et `parcours.mp4` au-delà de 50 Mio par la même boîte `free` pour forcer la compression.

Les tests produisent le WebP avec le canvas du navigateur. Ils construisent le MP4 de 50 Mio en ajoutant au MP4 une boîte ISO BMFF `free` remplie de zéros. Le test navigateur vérifie réellement sa lecture après téléversement et rechargement. FFmpeg n’est pas une dépendance du produit ni des tests.
