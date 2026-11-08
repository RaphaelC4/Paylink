@echo off
set FF=C:\Users\HP\.cargo\bin\ffmpeg.exe
set FR=C:\Users\HP\Documents\Paylink\docs\video-frames
set DOCS=C:\Users\HP\Documents\Paylink\docs

rem === step 1: subtitled 30s gasless clip ===
set GRAPH=[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,zoompan=z='1+0.10*on/240':d=240:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30,setsar=1[v0];[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,zoompan=z='1+0.10*on/240':d=240:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30,setsar=1[v1];[2:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,zoompan=z='1+0.10*on/240':d=240:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30,setsar=1[v2];[3:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,zoompan=z='1+0.10*on/240':d=240:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30,setsar=1[v3];[v0][v1]xfade=transition=fade:duration=0.6:offset=7.4[x1];[x1][v2]xfade=transition=fade:duration=0.6:offset=14.8[x2];[x2][v3]xfade=transition=fade:duration=0.6:offset=22.2[base];[base]drawtext=fontfile=C\\:/Windows/Fonts/arialbd.ttf:textfile=C\\:/Users/HP/Documents/Paylink/docs/video-frames/cap1.txt:fontsize=46:fontcolor=white:box=1:boxcolor=black@0.72:boxborderw=16:x=(w-tw)/2:y=h-th-70:enable=between(t\,0.4\,7)[c1];[c1]drawtext=fontfile=C\\:/Windows/Fonts/arialbd.ttf:textfile=C\\:/Users/HP/Documents/Paylink/docs/video-frames/cap2.txt:fontsize=46:fontcolor=white:box=1:boxcolor=black@0.72:boxborderw=16:x=(w-tw)/2:y=h-th-70:enable=between(t\,8.2\,14.4)[c2];[c2]drawtext=fontfile=C\\:/Windows/Fonts/arialbd.ttf:textfile=C\\:/Users/HP/Documents/Paylink/docs/video-frames/cap3.txt:fontsize=46:fontcolor=white:box=1:boxcolor=black@0.72:boxborderw=16:x=(w-tw)/2:y=h-th-70:enable=between(t\,15.6\,21.8)[c3];[c3]drawtext=fontfile=C\\:/Windows/Fonts/arialbd.ttf:textfile=C\\:/Users/HP/Documents/Paylink/docs/video-frames/cap4.txt:fontsize=46:fontcolor=white:box=1:boxcolor=black@0.72:boxborderw=16:x=(w-tw)/2:y=h-th-70:enable=between(t\,23\,30)[out]

%FF% -y -i "%FR%\01-before.jpeg" -i "%FR%\02-form.jpeg" -i "%FR%\03-sign.jpeg" -i "%FR%\04-after.jpeg" -filter_complex "%GRAPH%" -map "[out]" -c:v libx264 -preset fast -crf 21 -pix_fmt yuv420p -movflags +faststart "%FR%\sub.mp4" >"%FR%\sub.log" 2>&1
echo SUB_ENCODE=%ERRORLEVEL%
if errorlevel 1 goto :fail

rem === step 2: merge old demo + subtitled clip, normalized to 1920x1080 ===
set MG=[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v0];[1:v]setsar=1,fps=30,format=yuv420p[v1];[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0];[2:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:30.2,asetpts=PTS-STARTPTS[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]

%FF% -y -i "%DOCS%\Paylink-demo-final.mp4" -i "%FR%\sub.mp4" -f lavfi -t 30.2 -i anullsrc=channel_layout=stereo:sample_rate=48000 -filter_complex "%MG%" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 21 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "%DOCS%\Paylink-demo-full.mp4" >"%FR%\merge.log" 2>&1
echo MERGE=%ERRORLEVEL%
if errorlevel 1 goto :fail
echo ALL_DONE
exit /b 0

:fail
echo FAILED_SEE_LOGS
exit /b 1
