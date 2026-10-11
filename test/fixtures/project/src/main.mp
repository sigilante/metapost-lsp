% Test project: inputs resolve relative to the project root, as in a
% normal `mpost src/main.mp` build.
outputformat := "svg";
outputtemplate := "%j-%c.svg";

numeric stem_width,   % weight of vertical strokes
  x_height;
stem_width := 12;
x_height := 400;

% Half the breadth of the current pen in direction d.
vardef penradius(expr d) =
  (penoffset (d rotated 90) of currentpen) dotprod unitvector(d)
enddef;

def stroke_with(expr p)(suffix s) text t =
  draw p t;
enddef;

primarydef a midway b = .5[a, b] enddef;

vardef ladder(expr n) =
  save i, step_y;
  step_y := x_height / n;
  for i = 1 upto n:
    draw (0, i * step_y) -- (stem_width, i * step_y);
  endfor
enddef;

pen thin_pen; thin_pen = pencircle scaled 1;

input src/glyphs/a.mp; % Letter a
input src/glyphs/b.mp;
end
