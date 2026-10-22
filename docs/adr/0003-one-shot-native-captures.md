# 0003. One-shot native captures, images read on demand

Reviewers need a faithful image of what they saw, and accepting the browser's tab-sharing prompt is an acceptable price. Socrate therefore stores one image per new targeted comment and never records the session. A DOM replay would add another data collection and a rendering dependency that the product does not need. The API exposes capture metadata separately from its bytes, so agents only download the images they need.

A targeted publication requires the image taken at targeting time. After an interruption, the draft text is kept and a new explicit targeting is required once capture is available again. Socrate never publishes a targeted comment silently deprived of its image, and never presents an HTML reconstruction as a faithful capture.

Consequence: captures work in browsers that implement `getDisplayMedia` for the current tab, in practice Chromium-based browsers. A synthetic test with automatic permission does not prove the native picker; it is verified separately.
