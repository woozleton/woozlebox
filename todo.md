TO DO NOW: 
-----------

- In music studio, the current goal is to generate an image that represents each created song automatically. To do this, find and install the best small image model that will sit alongside ace-step-1.5 and an appropriate LLM. Preferably, all models would fit in the 4090s VRAM simultaneously.  This new image model should also be selectable from image studio if the user wants to use it on its own. 

- If feasible without too many VRAM loads/unloads, Image Studio & Chat should both have their 'sessions' renamed automatically based on the content of the image request or conversation.  

- All em-dashes need to be removed, everywhere.  

LONG-TERM (don't do until user tells you to)
-----------

Custom TTS voice - Your plan already covers the Sesame CSM swap which includes voice cloning. Blocked on that migration.

Active avatar / face - Complex, needs a live animation pipeline.
Voice to Voice - Basically STT + LLM + TTS chained in real-time. Do STT first, then this becomes incremental.

