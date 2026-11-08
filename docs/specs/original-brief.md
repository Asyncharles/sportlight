
Sportlight - The moment is now. 

The idea: A streaming platform. Takes feeds from across all sports (providers) & provides intensity values in real time. These intensity values are merged with user preferences to create a view over the most important points to be watching at the time. 

To goal here is to provide an increadibly clean, simple UI experience for focusing on the intensity of sports. 

The best approach to this is a windowed layout. It should feel live with intensity ratings for each feed. The user should have one main view and then 3 side videos that refresh / change based on the new intensity scores. There should be a min time on this though so they don't pop in and out too quick. Plus since we will be showing the highest intensity we will need to handle replacing the lowest intensity one. 

This animation should be incredibly clean - fast minimal and satisfying. 

The frotent will speak to a lightweight backend via. a websocket for live streaming. 

The backend will be deployed on GCP and receive events from rabbit MQ. These events will just be intensity updates for a live stream + the video data. 

Have a mock rabbit MQ server that runs for now with video feedsa and live intensities that change over time. There will be a hardcoded config for now of the avilable sports. Each feed will stream live intensity and video. Feeds may close down / start up at any time. 

Backend shoudl just be ts. 

Bundle up this app with docker for deployment with rabbit MQ config. 

UI: 

See [the UI sketch](../ui-sketch.png). 

See [brand.css](../../brand.css).

See /logos. 

Have a darkmode and lightmode. Keep the config for this in a simple settings page. 

Use Lucide icons. 

Use vite, react & scss & ts. 

The best of today page will show the highest intensity windows from the day. Store video feeds and intensities that are recieved. Provide a clean view over the highest intensity clips from the day. These should be sized based on intensity but have way more clips on the screen than the lvie view. When the user clicks onto one show it in a bigger view with lots down the side for exploring. 

We should allow users to filter sports. So choose the sports they are morst interested in. (this could be extended to leagues etc. in the future)


